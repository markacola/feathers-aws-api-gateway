// import { createDebug } from '@feathersjs/commons'
import { Application } from '@feathersjs/feathers'
import { socket } from '@feathersjs/transport-commons'
import { setupLocalServer, addHandler, createHandler } from './server'
const isLambda = require('is-lambda')

import {
  disconnect,
  params,
  authentication,
  FeathersSocket,
} from './middleware'
import { Server } from 'http'
import WebSocket from 'ws'

// const debug = createDebug('feathers-aws-api-gateway')

function configureAwsApiGateway(): (app: Application) => void {
  return (app: Application) => {
    // map from connection id to feathers socket
    const idSocketMap: { [id: string]: FeathersSocket } = Object.create(null)
    // A mapping from connection to connection id
    const socketMap = new WeakMap<FeathersSocket, string>()
    // Function that gets the connection
    const getParams = (id: string) => idSocketMap[id]
    // Promise that resolves with the handler
    // when `setup` has been called
    const done = new Promise((resolve) => {
      const { setup } = app

      Object.assign(app, {
        async listen(
          this: any,
          port: number,
          ...args: any[]
        ): Promise<Server | void> {
          if (!isLambda) {
            const [server, wss] = setupLocalServer()
            await this.setup(wss)
            return server.listen(port, ...args)
          }

          this.setup()
        },
        setup(this: Application, wss: WebSocket.Server, ...rest: any[]) {
          const paramsInst = params(app, socketMap)
          const disconnectInst = disconnect(app, getParams)
          const authenticationInst = authentication(app)

          const handler = createHandler({
            async connect({ id, event: { multiValueHeaders }, context }) {
              console.log('connection %s', id, context)
              const feathersSocket = await paramsInst(id, multiValueHeaders)
              idSocketMap[id] = feathersSocket
              authenticationInst(feathersSocket, multiValueHeaders)
              return { statusCode: 200 }
            },
            async disconnect({ id, event, context }) {
              console.log('disconnect %s', id, event, context)
              disconnectInst(id)
              return { statusCode: 200 }
            },
            async default({ id, context, message }) {
              console.log('default message', id, context, message)
              return { statusCode: 200 }
            },
          })

          if (wss) {
            addHandler(wss, handler)
          }
          // TODO: export handler for lambda

          resolve(handler)
          return setup.call(this, ...rest)
        },
      })
    })

    app.configure(
      socket({
        done,
        socketMap,
        getParams,
        emit: 'emit',
      }),
    )
  }
}

export = configureAwsApiGateway
