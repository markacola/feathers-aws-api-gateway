import { strict as assert } from 'assert'
import {
  feathers,
  Application,
  HookContext,
  NullableId,
  Params,
} from '@feathersjs/feathers'
import { Server } from 'http'
import { Service } from './fixture'
import WebSocket from 'ws'

import methodTests from './methods'
import eventTests from './events'
import feathersAwsApiGateway from '../src'

const { PORT = 7886 } = process.env

class VerifierService {
  async find(params: Params) {
    return { params }
  }

  async create(data: any, params: Params) {
    return { data, params }
  }

  async update(id: NullableId, data: any, params: Params) {
    return { id, data, params }
  }
}

describe('feathers-aws-api-gateway', () => {
  let app: Application
  let server: Server
  let socket: WebSocket

  // const socketParams: any = {
  //   user: { name: 'David' },
  //   provider: 'feathers-aws-api-gateway',
  // }
  const options = {
    get socket() {
      return socket
    },
    get app() {
      return app
    },
  }

  before((done) => {
    const errorHook = (hook: HookContext) => {
      if (hook.params.query.hookError) {
        throw new Error(`Error from ${hook.method}, ${hook.type} hook`)
      }
    }

    app = feathers()
      .configure(feathersAwsApiGateway())
      .use('/todo', new Service())
      .use('/verify', new VerifierService())

    app.service('todo').hooks({
      before: {
        get: errorHook,
      },
    })
    ;(app as any).listen(PORT).then((srv: Server) => {
      server = srv
      server.once('listening', () => {
        app.use('/tasks', new Service())
        app.service('tasks').hooks({
          before: {
            get: errorHook,
          },
        })
      })
    })

    socket = new WebSocket(`ws://localhost:${PORT}`)
    socket.on('open', () => done())
  })

  after((done) => {
    server.close(done)
  })

  // it('passes handshake as service parameters', (done) => {
  //   socket.emit('create', 'verify', {}, (error: any, data: any) => {
  //     assert.ok(!error)
  //     assert.deepStrictEqual(
  //       omit(data.params, 'query', 'route', 'connection'),
  //       socketParams,
  //       'Passed handshake parameters',
  //     )

  //     socket.emit(
  //       'update',
  //       'verify',
  //       1,
  //       {},
  //       {
  //         test: 'param',
  //       },
  //       (error: any, data: any) => {
  //         assert.ok(!error)
  //         assert.deepStrictEqual(
  //           data.params,
  //           extend(
  //             {
  //               route: {},
  //               connection: socketParams,
  //               query: {
  //                 test: 'param',
  //               },
  //             },
  //             socketParams,
  //           ),
  //           'Passed handshake parameters as query',
  //         )
  //         done()
  //       },
  //     )
  //   })
  // })

  it('connection and disconnect events (#1243, #1238)', (done) => {
    const mySocket = new WebSocket(`ws://localhost:${PORT}?channel=dctest`)

    app.once('connection', (connection) => {
      assert.strictEqual(connection.channel, 'dctest')
      app.once('disconnect', (disconnection) => {
        assert.strictEqual(disconnection.channel, 'dctest')
        done()
      })
      setTimeout(() => mySocket.close(), 100)
    })

    assert.ok(mySocket)
  })

  // it('missing parameters in socket call works (#88)', (done) => {
  //   socket.emit('find', 'verify', (error: any, data: any) => {
  //     assert.ok(!error)
  //     assert.deepStrictEqual(
  //       omit(data.params, 'query', 'route', 'connection'),
  //       socketParams,
  //       'Handshake parameters passed on proper position',
  //     )
  //     done()
  //   })
  // })

  describe('Service method calls', () => {
    describe("('method', 'service')  event format", () => {
      describe('Service', () => methodTests('todo', options))
      describe('Dynamic Service', () => methodTests('todo', options))
    })
  })

  describe('Service events', () => {
    describe('Service', () => eventTests('todo', options))
    describe('Dynamic Service', () => eventTests('tasks', options))
  })
})
