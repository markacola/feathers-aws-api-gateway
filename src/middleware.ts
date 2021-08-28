import { Application } from '@feathersjs/feathers'
import { createDebug } from '@feathersjs/commons'
import { MultiValue } from './server'

const debug = createDebug('feathers-aws-api-gateway/middleware')

export type ParamsGetter = (id: string) => any
export type FeathersSocket = {
  provider: 'feathers-aws-api-gateway'
  connectionId: string
  headers: MultiValue
  authentication?: unknown
}

export const disconnect =
  (app: Application, getParams: ParamsGetter) =>
  async (connectionId: string) => {
    app.emit('disconnect', getParams(connectionId))
  }

export const params =
  (_app: Application, socketMap: WeakMap<any, any>) =>
  async (
    connectionId: string,
    multiValueHeaders?: MultiValue,
  ): Promise<FeathersSocket> => {
    const feathers: FeathersSocket = {
      provider: 'feathers-aws-api-gateway',
      connectionId,
      headers: multiValueHeaders,
    }

    socketMap.set(feathers, connectionId)
    return feathers
  }

export const authentication =
  (app: Application, settings: any = {}) =>
  async (
    feathersSocket: FeathersSocket,
    headers: FeathersSocket['headers'],
  ) => {
    const service = (app as any).defaultAuthentication
      ? (app as any).defaultAuthentication(settings.service)
      : null

    if (service === null) {
      return
    }

    const config = service.configuration
    const authStrategies = config.parseStrategies || config.authStrategies || []

    if (authStrategies.length === 0) {
      return
    }

    const authentication = await service.parse(headers, null, ...authStrategies)
    if (authentication) {
      debug('Parsed authentication from HTTP header', authentication)
      feathersSocket.authentication = authentication
      await service.create(authentication, {
        provider: 'feathers-aws-api-gateway',
        connection: feathersSocket,
      })
    }
  }
