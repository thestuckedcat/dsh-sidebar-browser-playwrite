import {randomUUID} from 'node:crypto'

export const inject = ['connection', 'webServer', 'tools', 'sessionController']
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/sidebar-smoke-driver',
    async handler(req, res) {
      if (req.method !== 'POST') { res.writeHead(405).end(); return }
      const admission = ctx.connection.admit(req)
      if ('rejection' in admission || admission.peer.principal.kind !== 'owner') {
        res.writeHead(403).end()
        return
      }
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const {rpcId, payload} = JSON.parse(Buffer.concat(chunks))
      try {
        const {agent, error} = await ctx.sessionController.resolveAgent(payload.sessionId)
        if (!agent) throw error
        const outcome = await ctx.tools.execute({name: payload.name, arguments: payload.args,
          agent, callId: randomUUID(), signal: AbortSignal.timeout(payload.timeoutMs ?? 12000)})
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({type:'server-response', rpcId, result:{ok:true, value:outcome}}))
      } catch (error) {
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({type:'server-response', rpcId, result:{ok:true, value:{error:String(error)}}}))
      }
    },
  }))
}
