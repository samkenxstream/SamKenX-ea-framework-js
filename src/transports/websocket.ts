import WebSocket, { ClientOptions, RawData } from 'ws'
import { EndpointContext } from '../adapter'
import { AdapterConfig } from '../config'
import { makeLogger, sleep } from '../util'
import { PartialSuccessfulResponse, ProviderResult, TimestampedProviderResult } from '../util/types'
import { TransportGenerics } from './'
import * as transportMetrics from './metrics'
import { StreamingTransport, SubscriptionDeltas } from './abstract/streaming'

// Aliasing type for use at adapter level
export { WebSocket, RawData as WebSocketRawData }

const logger = makeLogger('WebSocketTransport')

type WebSocketClass = new (
  url: string,
  protocols?: string | string[] | undefined,
  options?: ClientOptions,
) => WebSocket

export class WebSocketClassProvider {
  static ctor: WebSocketClass = WebSocket

  static set(ctor: WebSocketClass): void {
    this.ctor = ctor
  }

  static get(): WebSocketClass {
    return this.ctor
  }
}

/**
 * Config object that is provided to the WebSocketTransport constructor.
 */
export interface WebSocketTransportConfig<T extends WebsocketTransportGenerics> {
  /** Endpoint to which to open the WS connection*/
  url: (
    context: EndpointContext<T>,
    desiredSubs: T['Request']['Params'][],
  ) => Promise<string> | string

  /** Optional parameters used when establishing the WebSocket connection */
  options?: (context: EndpointContext<T>) => Promise<ClientOptions> | ClientOptions

  /** Map of handlers for different WS lifecycle events */
  handlers: {
    /**
     * Handles when the WS is successfully opened.
     * Optional since logic is not always needed on connection.
     *
     * @param wsConnection - the WebSocket with an established connection
     * @returns an empty Promise, or void
     */
    open?: (wsConnection: WebSocket, context: EndpointContext<T>) => Promise<void> | void

    /**
     * Handles when the WS receives a message
     *
     * @param message - the message received by the WS
     * @param context - the background context for the Adapter
     * @param params - current params in the subscription set
     * @returns a list of cache entries of adapter responses to set in the cache
     */
    message: (
      message: T['Provider']['WsMessage'],
      context: EndpointContext<T>,
      params: T['Request']['Params'][]
    ) => ProviderResult<T>[] | undefined
  }

  /** Map of "builders", functions that will be used to prepare specific WS messages */
  builders?: {
    /**
     * Builds a WS message that will be sent to subscribe to a specific feed
     *
     * @param params - the body of the adapter request
     * @returns the WS message (can be any type as long as the [[WebSocket]] doesn't complain)
     */
    subscribeMessage?: (params: T['Request']['Params']) => unknown

    /**
     * Builds a WS message that will be sent to unsubscribe to a specific feed
     *
     * @param params - the body of the adapter request
     * @returns the WS message (can be any type as long as the [[WebSocket]] doesn't complain)
     */
    unsubscribeMessage?: (params: T['Request']['Params']) => unknown
  }
}

/**
 * Helper struct type that will be used to pass types to the generic parameters of a Transport.
 * Extends the common TransportGenerics, adding Provider specific types for this WS endpoint.
 */
type WebsocketTransportGenerics = TransportGenerics & {
  /**
   * Type details for any provider specific interfaces.
   */
  Provider: {
    /**
     * Structure of any message that will come through the websocket connection.
     */
    WsMessage: unknown
  }
}

/**
 * Transport implementation that takes incoming requests, adds them to an [[subscriptionSet]] and,
 * through a WebSocket connection, subscribes to the relevant feeds to populate the cache.
 *
 * @typeParam T - Helper struct type that will be used to pass types to the generic parameters (check [[WebsocketTransportGenerics]])
 */
export class WebSocketTransport<
  T extends WebsocketTransportGenerics,
> extends StreamingTransport<T> {
  wsConnection!: WebSocket
  currentUrl = ''
  lastMessageReceivedAt = 0
  connectionOpenedAt = 0
  desiredSubscriptions: T['Request']['Params'][] = []

  constructor(private config: WebSocketTransportConfig<T>) {
    super()
  }

  getSubscriptionTtlFromConfig(config: AdapterConfig<T['CustomSettings']>): number {
    return config.WS_SUBSCRIPTION_TTL
  }

  connectionClosed(): boolean {
    return !this.wsConnection || this.wsConnection.readyState === WebSocket.CLOSED
  }

  serializeMessage(payload: unknown): string {
    return typeof payload === 'string' ? payload : JSON.stringify(payload)
  }
  deserializeMessage(data: WebSocket.Data): T['Provider']['WsMessage'] {
    return JSON.parse(data.toString()) as T['Provider']['WsMessage']
  }

  buildConnectionHandlers(
    context: EndpointContext<T>,
    connectionReadyResolve: (value: unknown) => void,
  ) {
    return {
      // Called when the WS connection is opened
      open: async (event: WebSocket.Event) => {
        logger.debug(`Opened websocket connection. (event type ${event.type})`)
        if (this.config.handlers.open) {
          await this.config.handlers.open(this.wsConnection, context)
          logger.debug('Successfully executed connection opened handler')
        }
        // Record active ws connections by incrementing count on open
        transportMetrics.wsConnectionActive.inc()
        connectionReadyResolve(true)
      },

      // Called when any message is received by the open connection
      message: async (event: WebSocket.MessageEvent) => {
        const parsed = this.deserializeMessage(event.data)
        logger.trace(`Got ws message: ${event.data}`)
        const providerDataReceived = Date.now()
        const results = this.config.handlers.message(parsed, context, this.desiredSubscriptions)?.map((r) => {
          const result = r as TimestampedProviderResult<T>
          const partialResponse = r.response as PartialSuccessfulResponse<T['Response']>
          result.response.timestamps = {
            providerDataStreamEstablished: this.providerDataStreamEstablished,
            providerDataReceived,
            providerIndicatedTime: partialResponse.timestamps?.providerIndicatedTime,
          }
          return result
        })
        if (Array.isArray(results)) {
          // Updating the last message received time here, to only care about messages we use
          this.lastMessageReceivedAt = Date.now()

          logger.trace(`Writing ${results.length} responses to cache`)
          await this.responseCache.write(results)
        }

        // Do this after writing so we get the values to the cache ASAP
        // We're not calculating feedId or subscription because this is only a single message,
        // and it could in theory contain more than one value to set to the cache
        transportMetrics.wsMessageTotal
          .labels({
            direction: 'received',
          })
          .inc()
      },

      // Called when an error is thrown by the connection
      error: async (event: WebSocket.ErrorEvent) => {
        logger.debug(
          `Error occurred in web socket connection. Error: ${event.error} ; Message: ${event.message}`,
        )
        // Record connection error count
        transportMetrics.wsConnectionErrors
          .labels(transportMetrics.connectionErrorLabels(event.message))
          .inc()
      },

      // Called when the WS connection closes for any reason
      close: (event: WebSocket.CloseEvent) => {
        logger.debug(
          `Closed websocket connection. Code: ${event.code} ; reason: ${event.reason?.toString()}`,
        )
        // Record active ws connections by decrementing count on close
        // Using URL in label since connection_key is removed from v3
        transportMetrics.wsConnectionActive.dec()
      },
    }
  }

  establishWsConnection(
    context: EndpointContext<T>,
    url: string,
    options?: WebSocket.ClientOptions | undefined,
  ) {
    return new Promise((resolve, reject) => {
      const ctor = WebSocketClassProvider.get()
      const handlers = this.buildConnectionHandlers(context, resolve)

      this.wsConnection = new ctor(url, undefined, options)
      this.wsConnection.addEventListener(
        'open',
        this.rejectionHandler<WebSocket.Event>(reject, handlers.open),
      )
      this.wsConnection.addEventListener(
        'message',
        this.rejectionHandler<WebSocket.MessageEvent>(reject, handlers.message),
      )
      this.wsConnection.addEventListener('error', handlers.error)
      this.wsConnection.addEventListener('close', handlers.close)
    })
  }

  async sendMessages(context: EndpointContext<T>, subscribes: unknown[], unsubscribes: unknown[]) {
    const serializedSubscribes = subscribes.map(this.serializeMessage)
    const serializedUnsubscribes = unsubscribes.map(this.serializeMessage)

    const messages = serializedSubscribes.concat(serializedUnsubscribes)
    for (const message of messages) {
      this.wsConnection.send(message)
    }
  }

  async streamHandler(
    context: EndpointContext<T>,
    subscriptions: SubscriptionDeltas<T['Request']['Params']>,
  ): Promise<void> {
    this.desiredSubscriptions = subscriptions.desired
    // New subs && no connection -> connect -> add subs
    // No new subs && no connection -> skip
    // New subs && connection -> add subs
    // No new subs && connection -> unsubs only
    if (!subscriptions.new.length && !this.wsConnection) {
      logger.debug('No entries in subscription set and no established connection, skipping')
      return
    }

    // We want to check if the URL we calculate is different from the one currently connected.
    // This is because some providers handle subscriptions on the URLs and not through messages.
    const urlFromConfig = await this.config.url(context, this.desiredSubscriptions)
    const urlChanged = this.currentUrl !== urlFromConfig

    // We want to check that if we have a connection, it hasn't gone stale. That is,
    // since opening it, have we had any activity from the provider.
    const now = Date.now()
    const timeSinceLastMessage = Math.max(0, now - this.lastMessageReceivedAt)
    const timeSinceConnectionOpened = Math.max(0, now - this.connectionOpenedAt)
    const timeSinceLastActivity = Math.min(timeSinceLastMessage, timeSinceConnectionOpened)
    const connectionUnresponsive =
      timeSinceLastActivity > 0 &&
      timeSinceLastActivity > context.adapterConfig.WS_SUBSCRIPTION_UNRESPONSIVE_TTL
    let connectionClosed = this.connectionClosed()

    // Check if we should close the current connection
    if (!connectionClosed && (urlChanged || connectionUnresponsive)) {
      const reason = urlChanged
        ? `Websocket url has changed from ${this.currentUrl} to ${urlFromConfig}, closing connection...`
        : `Last message was received ${timeSinceLastMessage} ago, exceeding the threshold of ${context.adapterConfig.WS_SUBSCRIPTION_UNRESPONSIVE_TTL}ms, closing connection...`
      logger.info(reason)
      this.wsConnection.close()
      connectionClosed = true

      // If the connection was closed, the new subscriptions should be the desired ones
      subscriptions.new = this.desiredSubscriptions
      if (subscriptions.new.length) {
        logger.trace(
          `Connection will be reopened and will subscribe to new and resubscribe to existing: ${JSON.stringify(
            subscriptions.new,
          )}`,
        )
      }
    }

    // Check if we need to open a new connection
    if (connectionClosed && this.desiredSubscriptions.length) {
      logger.debug('No established connection and new subscriptions available, connecting to WS')
      const options = this.config.options && (await this.config.options(context))
      this.currentUrl = urlFromConfig
      // Need to write this now, otherwise there could be messages sent with values before the open handler finishes
      this.providerDataStreamEstablished = Date.now()
      await this.establishWsConnection(context, urlFromConfig, options)
      this.connectionOpenedAt = Date.now()
    }

    if (this.config.builders) {
      logger.debug('Sending subs/unsubs if there are any')
      const { subscribeMessage, unsubscribeMessage } = this.config.builders
      await this.sendMessages(
        context,
        subscribeMessage ? subscriptions.new.map(subscribeMessage) : subscriptions.new,
        unsubscribeMessage ? subscriptions.stale.map(unsubscribeMessage) : subscriptions.stale,
      )
    }

    // Record WS message and subscription metrics
    transportMetrics.recordWsMessageMetrics(context, subscriptions.new, subscriptions.stale)

    // The background execute loop no longer sleeps between executions, so we have to do it here
    logger.trace(
      `Websocket handler complete, sleeping for ${context.adapterConfig.BACKGROUND_EXECUTE_MS_WS}ms...`,
    )
    await sleep(context.adapterConfig.BACKGROUND_EXECUTE_MS_WS)

    return
  }

  private rejectionHandler<E>(
    rejectionFn: (reason?: unknown) => void,
    handler: (event: E) => Promise<void>,
  ) {
    return async (event: E) => {
      try {
        await handler(event)
      } catch (e) {
        return rejectionFn(e)
      }
    }
  }
}
