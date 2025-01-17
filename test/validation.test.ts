import untypedTest, { TestFn } from 'ava'
import { Adapter, AdapterEndpoint, EndpointGenerics } from '../src/adapter'
import { AdapterConfig } from '../src/config'
import { AdapterResponse } from '../src/util'
import { AdapterInputError } from '../src/validation/error'
import { InputValidator } from '../src/validation/input-validator'
import { validator } from '../src/validation/utils'
import { NopTransport, NopTransportTypes, TestAdapter } from './util'

const test = untypedTest as TestFn<{
  testAdapter: TestAdapter
  adapterEndpoint: AdapterEndpoint<EndpointGenerics>
}>

test.beforeEach(async (t) => {
  const adapter = new Adapter({
    name: 'TEST',
    endpoints: [
      new AdapterEndpoint({
        name: 'test',
        inputParameters: {},
        transport: new (class extends NopTransport {
          override async foregroundExecute(): Promise<void | AdapterResponse<
            NopTransportTypes['Response']
          >> {
            return {
              data: null,
              statusCode: 200,
              result: null,
            } as AdapterResponse<NopTransportTypes['Response']>
          }
        })(),
      }),
    ],
  })

  t.context.adapterEndpoint = adapter.endpoints[0]
  t.context.testAdapter = await TestAdapter.start(adapter, t.context)
})

/**
 * NOTE: The tests here are run serially, because to avoid setting up and tearing down the adapter
 * for each one, we're just modifying the inputParameters and sending a new request every time
 */
test.serial('any content-type other than application/json throws 400', async (t) => {
  t.context.adapterEndpoint.inputParameters = {}

  const error = await t.context.testAdapter.api.inject({
    url: '/',
    method: 'post',
    payload: 'test string',
    headers: {
      'content-type': 'text/plain',
    },
  })
  t.is(error.statusCode, 400)
})

test.serial('no body in request throws 400', async (t) => {
  t.context.adapterEndpoint.inputParameters = {}

  const error = await t.context.testAdapter.api.inject({
    url: '/',
    method: 'post',
    payload: '',
    headers: {
      'content-type': 'application/json',
    },
  })
  t.is(error.statusCode, 400)
})

test.serial('invalid endpoint name throws 404', async (t) => {
  t.context.adapterEndpoint.inputParameters = {}

  const error = await t.context.testAdapter.request({ endpoint: 'random' })
  t.is(error.statusCode, 404)
})

test.serial('no endpoint without default throws 400', async (t) => {
  t.context.adapterEndpoint.inputParameters = {}

  const error = await t.context.testAdapter.request({})
  t.is(error.statusCode, 400)
})

test.serial('no params returns 200', async (t) => {
  t.context.adapterEndpoint.inputParameters = {}

  const response = await t.context.testAdapter.request({ endpoint: 'test' })
  t.is(response.statusCode, 200)
})

test.serial('missing required param throws 400', async (t) => {
  t.context.adapterEndpoint.inputParameters = {
    base: {
      type: 'string',
      required: true,
    },
  }
  t.context.adapterEndpoint.validator = new InputValidator(
    t.context.adapterEndpoint.inputParameters,
  )

  const error = await t.context.testAdapter.request({
    endpoint: 'test',
  })
  t.is(error.statusCode, 400)
})

test.serial('wrongly typed string throws 400', async (t) => {
  t.context.adapterEndpoint.inputParameters = {
    base: {
      type: 'string',
      required: true,
    },
  }
  t.context.adapterEndpoint.validator = new InputValidator(
    t.context.adapterEndpoint.inputParameters,
  )

  const error = await t.context.testAdapter.request({
    endpoint: 'test',
    base: 123,
  })
  t.is(error.statusCode, 400)
})

test.serial('wrongly typed number throws 400', async (t) => {
  t.context.adapterEndpoint.inputParameters = {
    base: {
      type: 'number',
      required: true,
    },
  }
  t.context.adapterEndpoint.validator = new InputValidator(
    t.context.adapterEndpoint.inputParameters,
  )

  const error = await t.context.testAdapter.request({
    endpoint: 'test',
    base: '123',
  })
  t.is(error.statusCode, 400)
})

test.serial('wrongly typed boolean throws 400', async (t) => {
  t.context.adapterEndpoint.inputParameters = {
    base: {
      type: 'boolean',
      required: true,
    },
  }
  t.context.adapterEndpoint.validator = new InputValidator(
    t.context.adapterEndpoint.inputParameters,
  )

  const error = await t.context.testAdapter.request({
    endpoint: 'test',
    base: '123',
  })
  t.is(error.statusCode, 400)
})

test.serial('wrongly typed array throws 400', async (t) => {
  t.context.adapterEndpoint.inputParameters = {
    base: {
      type: 'array',
      required: true,
    },
  }
  t.context.adapterEndpoint.validator = new InputValidator(
    t.context.adapterEndpoint.inputParameters,
  )

  const error = await t.context.testAdapter.request({
    endpoint: 'test',
    base: '123',
  })
  t.is(error.statusCode, 400)
})

test.serial('wrongly typed object throws 400', async (t) => {
  t.context.adapterEndpoint.inputParameters = {
    base: {
      type: 'object',
      required: true,
    },
  }
  t.context.adapterEndpoint.validator = new InputValidator(
    t.context.adapterEndpoint.inputParameters,
  )

  const error = await t.context.testAdapter.request({
    endpoint: 'test',
    base: '123',
  })
  t.is(error.statusCode, 400)
})

test.serial('wrongly typed optional param throws 400', async (t) => {
  t.context.adapterEndpoint.inputParameters = {
    base: {
      type: 'string',
      required: false,
    },
  }
  t.context.adapterEndpoint.validator = new InputValidator(
    t.context.adapterEndpoint.inputParameters,
  )

  const error = await t.context.testAdapter.request({
    endpoint: 'test',
    base: 123,
  })
  t.is(error.statusCode, 400)
})

test.serial('param not in options throws 400', async (t) => {
  t.context.adapterEndpoint.inputParameters = {
    base: {
      type: 'string',
      required: true,
      options: ['ETH', 'BTC'],
    },
  }
  t.context.adapterEndpoint.validator = new InputValidator(
    t.context.adapterEndpoint.inputParameters,
  )

  const error = await t.context.testAdapter.request({
    endpoint: 'test',
    base: 'LINK',
  })
  t.is(error.statusCode, 400)
})

test.serial('missing dependent params throws 400', async (t) => {
  t.context.adapterEndpoint.inputParameters = {
    base: {
      type: 'string',
      required: false,
      dependsOn: ['quote'],
    },
    quote: {
      required: false,
    },
  }
  t.context.adapterEndpoint.validator = new InputValidator(
    t.context.adapterEndpoint.inputParameters,
  )
  const error = await t.context.testAdapter.request({
    endpoint: 'test',
    base: 'ETH',
  })
  t.is(error.statusCode, 400)
})

test.serial('presented exclusive params throws 400', async (t) => {
  t.context.adapterEndpoint.inputParameters = {
    base: {
      type: 'string',
      required: false,
      exclusive: ['quote'],
    },
    quote: {
      required: false,
    },
  }
  t.context.adapterEndpoint.validator = new InputValidator(
    t.context.adapterEndpoint.inputParameters,
  )

  const error = await t.context.testAdapter.request({
    endpoint: 'test',
    base: 'ETH',
    quote: 'USD',
  })
  t.is(error.statusCode, 400)
})

test.serial('invalid overrides object throws 400', async (t) => {
  t.context.adapterEndpoint.inputParameters = {
    base: {
      type: 'string',
      required: false,
    },
    quote: {
      type: 'string',
      required: false,
    },
  }
  t.context.adapterEndpoint.validator = new InputValidator(
    t.context.adapterEndpoint.inputParameters,
  )

  const error = await t.context.testAdapter.request({
    endpoint: 'test',
    base: 'OVER2',
    quote: 'USD',
    overrides: 'test',
  })
  t.is(error.statusCode, 400)
})

test.serial('invalid overrides key throws 400', async (t) => {
  t.context.adapterEndpoint.inputParameters = {
    base: {
      type: 'string',
      required: false,
    },
    quote: {
      type: 'string',
      required: false,
    },
  }
  t.context.adapterEndpoint.validator = new InputValidator(
    t.context.adapterEndpoint.inputParameters,
  )

  const error = await t.context.testAdapter.request({
    endpoint: 'test',
    base: 'OVER2',
    quote: 'USD',
    overrides: {
      test: {
        OVER2: {
          json: '123',
        },
      },
    },
  })
  t.is(error.statusCode, 400)
})

test.serial('correctly typed params returns 200', async (t) => {
  t.context.adapterEndpoint.inputParameters = {
    string: {
      type: 'string',
      required: true,
    },
    array: {
      type: 'array',
      required: true,
    },
    object: {
      type: 'object',
      required: true,
    },
    boolean: {
      type: 'boolean',
      required: true,
    },
    number: {
      type: 'number',
      required: true,
    },
  }
  t.context.adapterEndpoint.validator = new InputValidator(
    t.context.adapterEndpoint.inputParameters,
  )

  const response = await t.context.testAdapter.request({
    endpoint: 'test',
    string: 'test',
    number: 2,
    boolean: false,
    array: [1, 'test'],
    object: { test: 'test' },
  })
  t.is(response.statusCode, 200)
})

test.serial('omitted optional param returns 200', async (t) => {
  t.context.adapterEndpoint.inputParameters = {
    base: {
      type: 'string',
      required: false,
    },
  }
  t.context.adapterEndpoint.validator = new InputValidator(
    t.context.adapterEndpoint.inputParameters,
  )

  const response = await t.context.testAdapter.request({
    endpoint: 'test',
  })
  t.is(response.statusCode, 200)
})

test.serial('duplicate params throws 400', async (t) => {
  t.context.adapterEndpoint.inputParameters = {
    base: {
      required: true,
      aliases: ['base', 'quote'],
    },
  }
  const error: AdapterInputError | undefined = t.throws(() => {
    t.context.adapterEndpoint.validator = new InputValidator(
      t.context.adapterEndpoint.inputParameters,
    )
  })

  t.is(error?.statusCode, 400)
  t.is(error?.message, 'Duplicate aliases')
})

test.serial('default value is used for optional param', async (t) => {
  t.context.adapterEndpoint.inputParameters = {
    base: {
      required: false,
      default: 'ETH',
    },
  }

  t.context.adapterEndpoint.validator = new InputValidator(
    t.context.adapterEndpoint.inputParameters,
  )

  const data = t.context.adapterEndpoint.validator.validateInput({})
  t.is(data['base'], 'ETH')
})

test.serial('default value is used for required param (error)', async (t) => {
  t.context.adapterEndpoint.inputParameters = {
    base: {
      required: true,
      default: 'ETH',
    },
  }

  const error: AdapterInputError | undefined = t.throws(() => {
    t.context.adapterEndpoint.validator = new InputValidator(
      t.context.adapterEndpoint.inputParameters,
    )
  })

  t.is(error?.statusCode, 400)
  t.is(error?.message, "base can't be required and have default value")
})

test.serial('missing input depends on param (error)', async (t) => {
  t.context.adapterEndpoint.inputParameters = {
    base: {
      required: false,
      default: 'ETH',
      dependsOn: ['quote'],
    },
  }

  const error: AdapterInputError | undefined = t.throws(() => {
    t.context.adapterEndpoint.validator = new InputValidator(
      t.context.adapterEndpoint.inputParameters,
    )
  })

  t.is(error?.statusCode, 400)
  t.is(error?.message, "Input dependency/exclusive 'quote' is missing in input schema")
})

test.serial('Test port validator', async (t) => {
  const portValidator = validator.port()
  let value = 8080
  let error = portValidator(value)
  t.is(error, undefined)
  value = 1000000
  error = portValidator(value)
  t.is(error, 'Maximum allowed value is 65535. Received 1000000')
})

test.serial('Test url validator', async (t) => {
  const urlValidator = validator.url()
  let value = 'redis://:authpassword@127.0.0.1:6380/4'
  let error = urlValidator(value)
  t.is(error, undefined)
  value = 'unknown_url'
  error = urlValidator(value)
  t.is(error, 'Value should be valid URL. Received unknown_url')
})

test.serial('Test host validator', async (t) => {
  const hostValidator = validator.host()
  let value = '127.0.0.1'
  let error = hostValidator(value)
  t.is(error, undefined)
  value = '23124.32.42.24'
  error = hostValidator(value)
  t.is(error, 'Value is not valid IP address. Received 23124.32.42.24')
})

test.serial('Test integer validator', async (t) => {
  const integerValidator = validator.integer({ min: 10, max: 20 })
  let value: string | number = 11
  let error = integerValidator(value)
  t.is(error, undefined)
  value = '3'
  error = integerValidator(value)
  t.is(error, 'Value should be an integer (no floating point)., Received string 3')
  value = 3.141
  error = integerValidator(value)
  t.is(error, 'Value should be an integer (no floating point)., Received number 3.141')

  value = 4
  error = integerValidator(value)
  t.is(error, 'Minimum allowed value is 10. Received 4')

  value = 24
  error = integerValidator(value)
  t.is(error, 'Maximum allowed value is 20. Received 24')
})

test.serial('custom input validation', async (t) => {
  t.context.adapterEndpoint.inputParameters = {
    base: {
      type: 'string',
      required: true,
    },
    quote: {
      type: 'string',
      required: true,
    },
  }
  const customInputValidation = (input: any, _: AdapterConfig) => {
    if (input.requestContext.data.base === input.requestContext.data.quote) {
      return new AdapterInputError({ statusCode: 400 })
    }
  }

  t.context.adapterEndpoint.customInputValidation = customInputValidation

  t.context.adapterEndpoint.validator = new InputValidator(
    t.context.adapterEndpoint.inputParameters,
  )

  const response = await t.context.testAdapter.request({
    base: 'BTC',
    quote: 'USD',
    endpoint: 'test',
  })
  t.is(response.statusCode, 200)

  const error = await t.context.testAdapter.request({
    base: 'BTC',
    quote: 'BTC',
    endpoint: 'test',
  })
  t.is(error.statusCode, 400)
})

test.serial('limit size of input parameters', async (t) => {
  process.env['MAX_PAYLOAD_SIZE_LIMIT'] = '1048576'

  const adapter = new Adapter({
    name: 'TEST',
    endpoints: [
      new AdapterEndpoint({
        name: 'test',
        inputParameters: {},
        transport: new (class extends NopTransport {
          override async foregroundExecute(): Promise<void | AdapterResponse<
            NopTransportTypes['Response']
          >> {
            return {
              data: null,
              statusCode: 413,
              result: null,
            } as AdapterResponse<NopTransportTypes['Response']>
          }
        })(),
      }),
    ],
  })

  t.context.adapterEndpoint = adapter.endpoints[0]
  t.context.adapterEndpoint.inputParameters = {
    addresses: {
      type: 'array',
      required: true,
    },
  }
  t.context.adapterEndpoint.validator = new InputValidator(
    t.context.adapterEndpoint.inputParameters,
  )

  const request = {
    addresses: [
      '0x933ad9491b62059dd065b560d256d8957a8c402cc6e8d8ee7290ae11e8f7329267a8811c397529dac52ae1342ba58c95',
    ],
  }

  for (let i = 0; i < 14; i++) {
    request.addresses = request.addresses.concat(request.addresses)
  }
  const error = await t.context.testAdapter.request(request)
  t.is(error.statusCode, 413)
  t.is(error.body, 'Request body is too large')
})
