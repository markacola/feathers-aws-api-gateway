import { createServer, IncomingMessage, Server } from 'http'
import WebSocket from 'ws'
const isLambda = require('is-lambda')
const postToConnection = require('aws-post-to-connection')
const mappingKey = process.env.MAPPING_KEY || 'message'

// export function server(handler) {
//   if (isLambda) {
//     return handler
//   }
//   // TODO: setup server
// }

export interface MultiValue {
  [k: string]: string | string[]
}
type EventType = 'CONNECT' | 'DISCONNECT' | 'MESSAGE'
interface Event {
  requestContext: {
    routeKey: string
    eventType: EventType
    connectionId: string
  }
  multiValueQueryStringParameters: MultiValue
  multiValueHeaders: MultiValue
  body: string
  isBase64Encoded?: boolean
}
interface Context {
  getRemainingTimeInMillis: () => number
  postToConnection: (payload: object, connectionId: string) => Promise<void>
}
interface ConnectionArgs {
  id: string
  event: Event
  context: Context
}
interface MessageArgs extends ConnectionArgs {
  message: { [k: string]: unknown }
}
interface ResponseType {
  statusCode: 200
}
interface Routes {
  connect?: (c: ConnectionArgs) => Promise<ResponseType>
  disconnect?: (c: ConnectionArgs) => Promise<ResponseType>
  default?: (m: MessageArgs) => Promise<ResponseType>
  [routeKey: string]: (m: MessageArgs) => Promise<ResponseType>
}
type Handler = (e: Event, c: Context) => Promise<ResponseType>
export const createHandler =
  (routes: Routes) =>
  async (event: Event, context: Context): Promise<ResponseType> => {
    if (isLambda) {
      context.postToConnection = postToConnection(event)
    }
    const { eventType, routeKey, connectionId } = event.requestContext
    const connectionArgs = { id: connectionId, event, context }
    switch (eventType) {
      case 'CONNECT':
        if (routes.connect) {
          return routes.connect(connectionArgs)
        } else {
          return { statusCode: 200 }
        }
      case 'DISCONNECT':
        if (routes.disconnect) {
          return routes.disconnect(connectionArgs)
        } else {
          return null
        }
      case 'MESSAGE':
        const body = JSON.parse(
          Buffer.from(
            event.body || '{}',
            event.isBase64Encoded ? 'base64' : undefined,
          ).toString(),
        )
        const messageArgs = { ...connectionArgs, message: body }
        if (routes[routeKey]) {
          return routes[routeKey](messageArgs)
        } else if (routes.default) {
          return routes.default(messageArgs)
        }
        return null
    }
    throw new Error(`Unknown event type: ${eventType}`)
  }

type WebSocketMap = { [k: string]: WebSocket }
export function setupLocalServer(): [Server, WebSocket.Server] {
  const clientsMap: WebSocketMap = {}
  const server = createServer((req, res) => {
    const connectionId = req.url.split('%40connections/')[1]
    if (!connectionId) {
      res.writeHead(404)
      res.end()
      return
    }
    let payload = ''
    req.on('data', (chunk) => {
      payload += chunk
    })
    req.on('end', () => {
      const ws = clientsMap[decodeURIComponent(connectionId)]
      if (!ws) {
        res.writeHead(410)
        res.end()
        return
      }
      ws.send(payload, (err) => {
        if (err) {
          console.error(err)
          res.writeHead(500)
          res.end()
        } else {
          res.end()
        }
      })
    })
  })
  ;(server as any).clientsMap = clientsMap

  const wss = new WebSocket.Server({
    server,
    verifyClient(info, fn) {
      wss.emit('verifyClient', info, fn)
    },
  })
  ;(wss as any).clientsMap = clientsMap

  return [server, wss]
}

const queryStringBuilder = ({ url }: IncomingMessage): MultiValue => {
  const result = new URLSearchParams(url)
  const keys = [...result.keys()]
  return keys.length === 0
    ? undefined
    : keys.reduce<MultiValue>((sum, key) => {
        const items = result.getAll(key)
        sum[key] = items.length > 1 ? items : items[0]
        return sum
      }, {})
}

const headerBuilder = ({ headers }: IncomingMessage): MultiValue => {
  const keys = Object.keys(headers)
  return keys.length === 0
    ? undefined
    : keys.reduce<MultiValue>((sum, key) => {
        let value = headers[key]
        if (typeof value === 'string') {
          value = value.split(key === 'cookie' ? ';' : ',')
        }
        sum[key] = value
        return sum
      }, {})
}

const event = (
  routeKey: string,
  eventType: EventType,
  req: IncomingMessage,
  body = '',
): Event => ({
  requestContext: {
    routeKey,
    eventType,
    connectionId: req.headers['sec-websocket-key'],
  },
  multiValueQueryStringParameters: queryStringBuilder(req),
  multiValueHeaders: headerBuilder(req),
  body,
})

class StatusError extends Error {
  statusCode: number
}

const context = (clientsMap: WebSocketMap): Context => ({
  getRemainingTimeInMillis() {
    return 10000
  },
  async postToConnection(payload: object, connectionId: string) {
    return new Promise((resolve, reject) => {
      const ws = clientsMap[connectionId]
      if (!ws) {
        const err = new StatusError(`no client with ${connectionId} found`)
        err.statusCode = 410
        return reject(err)
      }
      ws.send(JSON.stringify(payload), (err) => {
        if (err) return reject(err)
        resolve()
      })
    })
  },
})

export function addHandler(wss: WebSocket.Server, handler: Handler) {
  const clients: WebSocketMap = (wss as any).clientsMap
  wss.removeAllListeners('verifyClient')
  wss.on('verifyClient', async (info, fn) => {
    const req = info.req
    try {
      const result = await handler(
        event('$connect', 'CONNECT', req),
        context(clients),
      )
      fn(result && result.statusCode === 200, result.statusCode)
    } catch (e) {
      console.error(e)
      fn(false, (e as ResponseType).statusCode)
    }
  })
  wss.removeAllListeners('connection')
  wss.on('connection', (ws, req) => {
    const connectionId = req.headers['sec-websocket-key']
    clients[connectionId] = ws
    ws.on('close', async () => {
      try {
        delete clients[connectionId]
        await handler(event('$disconnect', 'DISCONNECT', req), context(clients))
      } catch (e) {
        console.error(e)
      }
    })
    ws.on('message', async (message) => {
      try {
        if (typeof message !== 'string') {
          throw new Error('unexpected data type')
        }
        const body = JSON.parse(message || '{}')
        await handler(
          event(body[mappingKey] || '$default', 'MESSAGE', req, message),
          context(clients),
        )
      } catch (e) {
        console.error(e)
        try {
          await context(clients).postToConnection(
            {
              message: 'Internal server error',
              connectionId,
            },
            connectionId,
          )
        } catch (e) {
          console.error(e)
        }
      }
    })
  })
}
