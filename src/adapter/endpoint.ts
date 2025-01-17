import { ResponseCache } from '../cache/response'
import { AdapterConfig } from '../config'
import { Transport } from '../transports'
import { AdapterRequest, AdapterRequestData, makeLogger } from '../util'
import { SpecificInputParameters } from '../validation'
import { AdapterError } from '../validation/error'
import { InputValidator } from '../validation/input-validator'
import {
  AdapterDependencies,
  AdapterEndpointInterface,
  AdapterEndpointParams,
  CustomInputValidator,
  EndpointGenerics,
  EndpointRateLimitingConfig,
  Overrides,
  RequestTransform,
} from './types'

const logger = makeLogger('AdapterEndpoint')
const DEFAULT_TRANSPORT_NAME = 'default_single_transport'

/**
 * Main class to represent an endpoint within an External Adapter
 */
export class AdapterEndpoint<T extends EndpointGenerics> implements AdapterEndpointInterface<T> {
  name: string
  aliases?: string[] | undefined
  transports: Record<string, Transport<T>>
  inputParameters: SpecificInputParameters<T['Request']['Params']>
  rateLimiting?: EndpointRateLimitingConfig | undefined
  validator: InputValidator
  cacheKeyGenerator?: (data: Record<string, unknown>) => string
  customInputValidation?: CustomInputValidator<T>
  requestTransforms?: RequestTransform<T>[]
  overrides?: Record<string, string> | undefined
  customRouter?: (
    req: AdapterRequest<T['Request']>,
    adapterConfig: AdapterConfig<T['CustomSettings']>,
  ) => string
  defaultTransport?: string

  constructor(params: AdapterEndpointParams<T>) {
    this.name = params.name
    this.aliases = params.aliases
    // These ifs are annoying but it's to make it type safe
    if ('transports' in params) {
      this.transports = params.transports
      this.customRouter = params.customRouter
      this.defaultTransport = params.defaultTransport

      // Validate transport names
      for (const transportName in this.transports) {
        // This is intentional, to keep names to one word only
        if (!/^[a-z]+$/.test(transportName)) {
          throw new Error(
            `Transport name "${transportName}" is invalid. Names in the AdapterEndpoint transports map can only include lowercase letters.`,
          )
        }
      }
    } else {
      this.transports = {
        [DEFAULT_TRANSPORT_NAME]: params.transport,
      }
    }

    this.inputParameters = params.inputParameters
    this.rateLimiting = params.rateLimiting
    this.validator = new InputValidator(this.inputParameters)
    this.cacheKeyGenerator = params.cacheKeyGenerator
    this.customInputValidation = params.customInputValidation
    this.overrides = params.overrides
    this.requestTransforms = [this.symbolOverrider.bind(this), ...(params.requestTransforms || [])]
  }

  /**
   * Performs all necessary initialization processes that are async or need async initialized dependencies
   *
   * @param dependencies - all dependencies initialized at the adapter level
   * @param config - configuration for the adapter
   */
  async initialize(
    adapterName: string,
    dependencies: AdapterDependencies,
    config: AdapterConfig<T['CustomSettings']>,
  ): Promise<void> {
    const responseCache = new ResponseCache({
      dependencies,
      config: config as AdapterConfig,
      adapterName,
      endpointName: this.name,
      inputParameters: this.inputParameters,
    })

    const transportDependencies = {
      ...dependencies,
      responseCache,
    }

    logger.debug(`Initializing transports for endpoint "${this.name}"...`)
    for (const [transportName, transport] of Object.entries(this.transports)) {
      await transport.initialize(transportDependencies, config, this.name, transportName)
    }
  }

  /**
   * Takes the incoming request and applies all request transforms in the adapter
   *
   * @param req - the current adapter request
   * @returns the request after passing through all request transforms
   */
  runRequestTransforms(req: AdapterRequest): void {
    if (!this.requestTransforms) {
      return
    }

    for (const transform of this.requestTransforms) {
      transform(req)
    }
  }

  /**
   * Default request transform that takes requests and manipulates base params
   *
   * @param adapter - the current adapter
   * @param req - the current adapter request
   * @returns the modified (or new) request
   */
  symbolOverrider(req: AdapterRequest) {
    const rawRequestBody = req.body as { data?: { overrides?: Overrides } }
    const requestOverrides = rawRequestBody.data?.overrides?.[this.name.toLowerCase()]
    const base = req.requestContext.data['base'] as string

    if (requestOverrides?.[base]) {
      // Perform overrides specified in the request payload
      req.requestContext.data['base'] = requestOverrides[base]
    } else if (this.overrides?.[base]) {
      // Perform hardcoded adapter overrides
      req.requestContext.data['base'] = this.overrides[base]
    }

    return req
  }

  getTransportNameForRequest(
    req: AdapterRequest<T['Request']>,
    adapterConfig: AdapterConfig<T['CustomSettings']>,
  ): string {
    // If there's only one transport, return it
    if (this.transports[DEFAULT_TRANSPORT_NAME]) {
      return DEFAULT_TRANSPORT_NAME
    }

    // Attempt to get the transport to use from:
    //   1. Custom router (whatever logic the user wrote)
    //   2. Default router (try to get it from the input params)
    //   3. Default transport (if it was specified in the instance params)
    const rawTransportName =
      (this.customRouter && this.customRouter(req, adapterConfig)) ||
      this.defaultRouter(req) ||
      this.defaultTransport

    if (!rawTransportName) {
      throw new AdapterError({
        statusCode: 400,
        message: `No result was fetched from a custom router, no transport was specified in the input parameters, and this endpoint does not have a default transport set.`,
      })
    }

    const transportName = rawTransportName.toLowerCase()
    if (!this.transports[transportName]) {
      throw new AdapterError({
        statusCode: 400,
        message: `No transport found for key "${transportName}", must be one of ${JSON.stringify(
          Object.keys(this.transports),
        )}`,
      })
    }

    logger.debug(`Request will be routed to transport "${transportName}"`)
    return transportName
  }

  /**
   * Default routing strategy. Will try and use the transport input parameter if present in the request body.
   *
   * @param req - The current adapter request
   * @returns the transport param if present
   */
  private defaultRouter(req: AdapterRequest<T['Request']>) {
    const rawRequestBody = req.body as unknown as { data: AdapterRequestData }
    return rawRequestBody.data?.transport
  }
}
