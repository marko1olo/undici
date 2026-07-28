'use strict'

const { test, after } = require('node:test')
const { createServer } = require('node:http')
const { once } = require('node:events')
const { tspl } = require('@matteo.collina/tspl')
const undici = require('../..')

const {
  interceptors: { redirect }
} = undici

test('Client should throw redirect loop error for cross-origin redirect', async (t) => {
  t = tspl(t, { plan: 2 })

  const serverA = createServer((req, res) => {
    res.writeHead(301, {
      Location: 'http://localhost:9999/target' // Different port = cross-origin
    })
    res.end()
  })

  serverA.listen(0)
  after(() => serverA.close())
  await once(serverA, 'listening')

  const client = new undici.Client(`http://localhost:${serverA.address().port}`).compose(
    redirect({ maxRedirections: 2 })  // Keep low to avoid long waits
  )
  after(() => client.close())

  try {
    await client.request({
      method: 'GET',
      path: '/test'
    })
    t.fail('Expected error but request succeeded')
  } catch (error) {
    t.ok(error.message.includes('Redirect loop detected'), 'Error message indicates redirect loop')
    t.ok(error.message.includes('Client or Pool'), 'Error message mentions Client or Pool')
  }

  await t.completed
})

test('Pool should throw redirect loop error for cross-origin redirect', async (t) => {
  t = tspl(t, { plan: 2 })

  const serverA = createServer((req, res) => {
    res.writeHead(301, {
      Location: 'http://localhost:9998/target' // Different port = cross-origin
    })
    res.end()
  })

  serverA.listen(0)
  after(() => serverA.close())
  await once(serverA, 'listening')

  const pool = new undici.Pool(`http://localhost:${serverA.address().port}`).compose(
    redirect({ maxRedirections: 2 })  // Keep low to avoid long waits
  )
  after(() => pool.close())

  try {
    await pool.request({
      method: 'GET',
      path: '/test'
    })
    t.fail('Expected error but request succeeded')
  } catch (error) {
    t.ok(error.message.includes('Redirect loop detected'), 'Error message indicates redirect loop')
    t.ok(error.message.includes('Client or Pool'), 'Error message mentions Client or Pool')
  }

  await t.completed
})

test('Agent should successfully follow cross-origin redirect', async (t) => {
  t = tspl(t, { plan: 2 })

  const serverB = createServer((req, res) => {
    res.writeHead(200)
    res.end('Cross-origin redirect success')
  })

  const serverA = createServer((req, res) => {
    res.writeHead(301, {
      Location: `http://localhost:${serverB.address().port}/success`
    })
    res.end()
  })

  serverA.listen(0)
  serverB.listen(0)
  after(() => {
    serverA.close()
    serverB.close()
  })

  await Promise.all([
    once(serverA, 'listening'),
    once(serverB, 'listening')
  ])

  const agent = new undici.Agent().compose(
    redirect({ maxRedirections: 2 })
  )
  after(() => agent.close())

  const response = await agent.request({
    origin: `http://localhost:${serverA.address().port}`,
    method: 'GET',
    path: '/test'
  })

  const body = await response.body.text()

  t.strictEqual(response.statusCode, 200, 'Response has 200 status code')
  t.ok(body.includes('Cross-origin redirect success'), 'Response body indicates successful cross-origin redirect')

  await t.completed
})

test('Agent should follow a redirect chain that revisits an earlier URL', async (t) => {
  t = tspl(t, { plan: 2 })

  let appRequests = 0

  const server = createServer((req, res) => {
    if (req.url === '/app') {
      if (++appRequests === 1) {
        res.writeHead(302, { Location: '/login' })
        res.end()
      } else {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('App content')
      }
    } else {
      res.writeHead(302, { Location: '/app' })
      res.end()
    }
  })

  server.listen(0)
  after(() => server.close())
  await once(server, 'listening')

  const agent = new undici.Agent().compose(
    redirect({ maxRedirections: 5 })
  )
  after(() => agent.close())

  const response = await agent.request({
    origin: `http://localhost:${server.address().port}`,
    method: 'GET',
    path: '/app'
  })

  const body = await response.body.text()

  t.strictEqual(response.statusCode, 200, 'Response has 200 status code')
  t.ok(body.includes('App content'), 'Session bounce back to the original URL is followed')

  await t.completed
})

test('Agent should follow a 303 whose Location is the same URL', async (t) => {
  t = tspl(t, { plan: 2 })

  const server = createServer((req, res) => {
    if (req.method === 'POST') {
      res.writeHead(303, { Location: '/form' })
      res.end()
    } else {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('Form page')
    }
  })

  server.listen(0)
  after(() => server.close())
  await once(server, 'listening')

  const agent = new undici.Agent().compose(
    redirect({ maxRedirections: 5 })
  )
  after(() => agent.close())

  const response = await agent.request({
    origin: `http://localhost:${server.address().port}`,
    method: 'POST',
    path: '/form',
    body: 'a=1'
  })

  const body = await response.body.text()

  t.strictEqual(response.statusCode, 200, 'Response has 200 status code')
  t.ok(body.includes('Form page'), 'Post/Redirect/Get to the same path is followed')
})
