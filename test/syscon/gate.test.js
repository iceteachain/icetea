/* global jest describe test expect beforeAll afterAll */

const { randomAccountWithBalance, sleep } = require('../helper')
const { startupWith } = require('../../icetea/app/abcihandler')
const { IceteaWeb3 } = require('@iceteachain/web3')
const server = require('abci')
const createTempDir = require('tempy').directory
const { transpile } = global
// const { ecc } = require('@iceteachain/common')

jest.setTimeout(30000)

let tweb3
let richAccount // this key should have lots of coins before running test suite
let instance
beforeAll(async () => {
  const handler = await startupWith({ path: createTempDir() })
  instance = server(handler)
  instance.listen(global.ports.abci)
  await sleep(4000)

  tweb3 = new IceteaWeb3(`ws://127.0.0.1:${global.ports.rpc}/websocket`)
  richAccount = await randomAccountWithBalance(tweb3, 10e8)
})

afterAll(() => {
  tweb3.close()
  instance.close()
})

describe('gate', () => {
  test('gate call from client', async () => {
    const { privateKey, address: from } = richAccount
    tweb3.wallet.importAccount(privateKey)
    const opt = { from }

    const ms = tweb3.contract('system.gate').methods

    const request = () => {
      return ms.request('query/finance/crypto/rate', { symbol: 'BTC' }).sendCommit(opt)
    }
    await expect(request()).rejects.toThrowError('must be called from a contract')
  })

  test('gate call from contract', async () => {
    // process.env.NODE_ENV = 'development'
    const { privateKey, address: from } = richAccount
    tweb3.wallet.importAccount(privateKey)
    const opt = { from }
    const gate = tweb3.contract('system.gate')
    await gate.methods.registerProvider().sendCommit({ from, value: 10e6 })
    gate.events.OffchainDataQuery({}, async (error, event) => {
      if (error) {
        throw error
      }
      gate.methods.setResult(event.eventData.id, { test: 'hello' }).sendAsync(opt)
    })

    const src = await transpile(`
    @contract class X {
      @view @state result
      constructor () {
        const gate = loadContract('system.gate')
        gate.request.invokeUpdate({
          path: 'query/finance/crypto/rate',
          data: { symbol: 'BTC' }
        })
      }

      @transaction onOffchainData(requestId, requestData, result) {
        this.emitEvent('gotIt', result)
        this.result.value(result)
      }
    }
    `)
    const c = await tweb3.deploy(src, opt)
    await sleep(5000)
    const r = await c.methods.result().call()
    expect(r).toEqual({ test: 'hello' })
  })
})
