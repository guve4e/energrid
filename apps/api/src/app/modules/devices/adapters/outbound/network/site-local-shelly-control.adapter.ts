import { spawn } from 'node:child_process'
import { isIP } from 'node:net'
import type { AuthorizedSiteLocalObserver } from '../../../site-local-shelly-evidence-intake'
import type { AuthorizedSiteLocalShellyControlRoute } from '../../../site-local-shelly-control-route'
import type { NetworkDiscoveryZone } from '../../../device-registry.types'

const deadlineMs = 18_000
const maxBytes = 32 * 1024

export interface SiteLocalShellyRpcResult {
  identityBefore: unknown
  identityAfter: unknown | null
  componentKeys: string[]
  statusBefore: unknown | null
  statusAfter: unknown | null
  acknowledgement: unknown | null
  observedAt: string | null
  observer: { id: string; host: string; interfaceName: string; interfaceAddress: string }
  writeAttempted: boolean
  failure?: string
}

export class SiteLocalShellyCommandError extends Error {
  constructor(message: string, readonly writeMayHaveBeenSent: boolean) {
    super(message)
    this.name = 'SiteLocalShellyCommandError'
  }
}

/** Fixed SSH transport. Device identity, status parsing and authorization stay in the application services. */
export class SiteLocalShellyControlAdapter {
  readStatus(input: SiteLocalShellyRpcInput): Promise<SiteLocalShellyRpcResult> {
    return this.execute(input, 'read')
  }

  setSwitch(input: SiteLocalShellyRpcInput & { on: boolean }): Promise<SiteLocalShellyRpcResult> {
    return this.execute(input, 'set')
  }

  private execute(input: SiteLocalShellyRpcInput, mode: 'read' | 'set'): Promise<SiteLocalShellyRpcResult> {
    validateInput(input, mode)
    const scriptInput = {
      observer: { id: input.observer.id, host: input.observer.host, interfaceName: input.observer.interfaceName },
      cidr: input.zone.cidr,
      endpoint: input.ipAddress,
      physicalId: input.physicalId,
      component: input.component,
      expectedComponents: [...input.expectedComponentKeys].sort(),
      mode,
      ...(mode === 'set' ? { on: input.on } : {}),
    }
    const child = spawn('ssh', [
      '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5',
      '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
      '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2',
      input.observer.sshTarget!, `node -e ${shellQuote(SITE_LOCAL_SHELLY_RPC_SCRIPT)}`,
    ], { stdio: 'pipe' })
    let stdout = ''
    let stderrBytes = 0
    let writeMayHaveBeenSent = false
    let killedForLimit = false
    const kill = () => { killedForLimit = true; child.kill('SIGTERM') }
    const timer = setTimeout(kill, deadlineMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (Buffer.byteLength(stdout) > maxBytes) kill()
      if (stdout.split(/\r?\n/).some(line => line === '{"kind":"write_started"}')) writeMayHaveBeenSent = true
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderrBytes += Buffer.byteLength(chunk)
      if (stderrBytes > maxBytes) kill()
    })
    child.stderr.resume()
    child.stdin.on('error', () => {})
    child.stdin.end(`${JSON.stringify(scriptInput)}\n`)

    return new Promise((resolve, reject) => {
      child.once('error', () => {
        clearTimeout(timer)
        reject(new SiteLocalShellyCommandError('Authorized site-local SSH execution could not start.', writeMayHaveBeenSent))
      })
      child.once('close', code => {
        clearTimeout(timer)
        if (killedForLimit || code !== 0 || Buffer.byteLength(stdout) > maxBytes || stderrBytes > maxBytes) {
          reject(new SiteLocalShellyCommandError('Authorized site-local Shelly RPC execution did not complete within its limits.', writeMayHaveBeenSent))
          return
        }
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean)
        const line = [...lines].reverse().find(item => {
          try { return (JSON.parse(item) as Record<string, unknown>).kind === 'result' } catch { return false }
        })
        if (!line) {
          reject(new SiteLocalShellyCommandError('Authorized site-local Shelly RPC returned no structured result.', writeMayHaveBeenSent))
          return
        }
        try { resolve(validateResult(JSON.parse(line) as unknown, input, writeMayHaveBeenSent)) }
        catch { reject(new SiteLocalShellyCommandError('Authorized site-local Shelly RPC returned invalid structured evidence.', writeMayHaveBeenSent)) }
      })
    })
  }
}

export interface SiteLocalShellyRpcInput {
  zone: NetworkDiscoveryZone
  observer: AuthorizedSiteLocalObserver
  route?: AuthorizedSiteLocalShellyControlRoute
  tenantId: string
  siteId: string
  physicalId: string
  ipAddress: string
  component: string
  expectedComponentKeys: string[]
  on?: boolean
}

function validateInput(input: SiteLocalShellyRpcInput, mode: 'read' | 'set'): void {
  const componentMatch = /^switch:(0|[1-9]|[12][0-9]|3[01])$/.test(input.component)
  const physicalIdentityValid = /^shelly[a-z0-9._-]{1,114}$/i.test(input.physicalId)
  if (!input.observer.sshTarget || !input.observer.interfaceName || !input.zone.cidr ||
      input.zone.collectionSource === 'virtual-lab' || input.observer.tenantId !== input.tenantId ||
      input.observer.siteId !== input.siteId || input.observer.scopeId !== input.zone.id ||
      input.observer.cidr !== input.zone.cidr || isIP(input.ipAddress) !== 4 ||
      !ipInCidr(input.ipAddress, input.zone.cidr) || !physicalIdentityValid || !componentMatch ||
      !input.expectedComponentKeys.includes(input.component) ||
      (input.observer.expectedDeviceIds && !input.observer.expectedDeviceIds.some(id => id.toLowerCase() === input.physicalId.toLowerCase())) ||
      (input.observer.expectedComponentKeys && !input.observer.expectedComponentKeys.includes(input.component)) ||
      (mode === 'set' && (!input.route || input.route.observerId !== input.observer.id ||
        input.route.tenantId !== input.tenantId || input.route.siteId !== input.siteId ||
        input.route.scopeId !== input.zone.id || input.route.physicalId.toLowerCase() !== input.physicalId.toLowerCase() ||
        input.route.component !== input.component || typeof input.on !== 'boolean'))) {
    throw new Error(mode === 'set'
      ? 'No separately authorized site-local Shelly command route matches this device component.'
      : 'The site-local Shelly read route does not match its enrolled site and observer scope.')
  }
}

function validateResult(value: unknown, input: SiteLocalShellyRpcInput, writeMayHaveBeenSent: boolean): SiteLocalShellyRpcResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape')
  const result = value as Record<string, unknown>
  const observer = result.observer as Record<string, unknown> | undefined
  const exactObserver = observer?.id === input.observer.id && observer.host?.toString().toLowerCase() === input.observer.host.toLowerCase() &&
    observer.interfaceName === input.observer.interfaceName && typeof observer.interfaceAddress === 'string' &&
    isIP(observer.interfaceAddress) === 4 && ipInCidr(observer.interfaceAddress, input.zone.cidr!)
  const keys = result.componentKeys
  const expected = [...input.expectedComponentKeys].sort()
  const exactComponents = Array.isArray(keys) && keys.length === expected.length &&
    [...keys].sort().every((key, index) => key === expected[index])
  const validTime = typeof result.observedAt === 'string' && Number.isFinite(Date.parse(result.observedAt)) &&
    Date.parse(result.observedAt) <= Date.now() + 30_000 && Date.now() - Date.parse(result.observedAt) <= 15 * 60_000
  if (result.kind !== 'result' || !exactObserver || !exactComponents || !validTime ||
      typeof result.writeAttempted !== 'boolean' || (result.writeAttempted && !writeMayHaveBeenSent) ||
      !result.identityBefore || typeof result.identityBefore !== 'object') throw new Error('result')
  return {
    identityBefore: result.identityBefore,
    identityAfter: result.identityAfter ?? null,
    componentKeys: keys as string[],
    statusBefore: result.statusBefore ?? null,
    statusAfter: result.statusAfter ?? null,
    acknowledgement: result.acknowledgement ?? null,
    observedAt: result.observedAt as string,
    observer: { id: observer!.id as string, host: observer!.host as string,
      interfaceName: observer!.interfaceName as string, interfaceAddress: observer!.interfaceAddress as string },
    writeAttempted: result.writeAttempted as boolean,
    ...(typeof result.failure === 'string' ? { failure: result.failure } : {}),
  }
}

function ipInCidr(ip: string, cidr: string): boolean {
  const [network, prefixText] = cidr.split('/')
  const octets = (value: string) => value.split('.').map(Number)
  const address = octets(ip); const base = octets(network); const prefix = Number(prefixText)
  if (address.length !== 4 || base.length !== 4 || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false
  const value = address.reduce((sum, part) => ((sum << 8) | part) >>> 0, 0)
  const networkValue = base.reduce((sum, part) => ((sum << 8) | part) >>> 0, 0)
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (value & mask) === (networkValue & mask)
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// The remote process transports bounded RPC responses only. The API performs
// all identity, component, site, permission and readback decisions.
const SITE_LOCAL_SHELLY_RPC_SCRIPT = String.raw`
const os=require('node:os');let text='';process.stdin.setEncoding('utf8');
process.stdin.on('data',c=>{text+=c;if(Buffer.byteLength(text)>16384)process.exit(2)});
async function read(ip,path){const r=await fetch('http://'+ip+path,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(2500),headers:{Accept:'application/json','Cache-Control':'no-cache'}});if(r.status>=300&&r.status<400||!r.ok)throw Error('rpc');const b=await r.text();if(Buffer.byteLength(b)>8192)throw Error('size');const v=JSON.parse(b);if(!v||typeof v!=='object'||Array.isArray(v)||'error'in v)throw Error('shape');return v}
async function write(ip,params){const r=await fetch('http://'+ip+'/rpc/Switch.Set',{method:'POST',redirect:'manual',signal:AbortSignal.timeout(2500),headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify(params)});if(r.status>=300&&r.status<400||!r.ok)throw Error('rpc');const b=await r.text();if(Buffer.byteLength(b)>8192)throw Error('size');const v=JSON.parse(b);if(!v||typeof v!=='object'||Array.isArray(v)||'error'in v)throw Error('shape');return v}
function inCidr(ip,cidr){const[n,p]=cidr.split('/'),a=ip.split('.').map(Number),b=n.split('.').map(Number),bits=Number(p);if(a.length!==4||b.length!==4||!Number.isInteger(bits)||bits<0||bits>32)return false;const v=a.reduce((x,y)=>((x<<8)|y)>>>0,0),base=b.reduce((x,y)=>((x<<8)|y)>>>0,0),mask=bits===0?0:(0xffffffff<<(32-bits))>>>0;return(v&mask)===(base&mask)}
process.stdin.on('end',async()=>{let input;try{input=JSON.parse(text)}catch{process.exit(2)}if(!input||!['read','set'].includes(input.mode)||!inCidr(input.endpoint,input.cidr)||!/^shelly[a-z0-9._-]{1,114}$/.test(input.physicalId)||!/^switch:(0|[1-9]|[12][0-9]|3[01])$/.test(input.component)||!Array.isArray(input.expectedComponents)||!input.expectedComponents.includes(input.component)||input.mode==='set'&&typeof input.on!=='boolean')process.exit(2);const channel=Number(input.component.split(':')[1]);const address=(os.networkInterfaces()[input.observer.interfaceName]||[]).find(x=>!x.internal&&x.family==='IPv4'&&inCidr(x.address,input.cidr));if(os.hostname().toLowerCase()!==input.observer.host.toLowerCase()||!address)process.exit(2);let identityBefore=null,identityAfter=null,componentKeys=[],statusBefore=null,statusAfter=null,acknowledgement=null,writeAttempted=false,failure;try{identityBefore=await read(input.endpoint,'/rpc/Shelly.GetDeviceInfo');if(identityBefore.id!==input.physicalId||typeof identityBefore.gen!=='number'||identityBefore.gen<2)throw Error('identity_before');const components=await read(input.endpoint,'/rpc/Shelly.GetComponents');if(!Array.isArray(components.components)||!Number.isInteger(components.total)||components.total>32||components.offset!==0)throw Error('components');componentKeys=components.components.filter(x=>x&&typeof x.key==='string'&&/^switch:[0-9]+$/.test(x.key)).map(x=>x.key).sort();if(componentKeys.length!==input.expectedComponents.length||componentKeys.some((x,i)=>x!==input.expectedComponents[i]))throw Error('components');statusBefore=await read(input.endpoint,'/rpc/Switch.GetStatus?id='+channel);if(statusBefore.id!==channel||typeof statusBefore.output!=='boolean')throw Error('status');if(input.mode==='set'){process.stdout.write(JSON.stringify({kind:'write_started'})+'\n');writeAttempted=true;acknowledgement=await write(input.endpoint,{id:channel,on:input.on});if(typeof acknowledgement.was_on!=='boolean')throw Error('ack');statusAfter=await read(input.endpoint,'/rpc/Switch.GetStatus?id='+channel);if(statusAfter.id!==channel||typeof statusAfter.output!=='boolean')throw Error('status_after')}identityAfter=await read(input.endpoint,'/rpc/Shelly.GetDeviceInfo');if(identityAfter.id!==input.physicalId||identityAfter.gen<2)throw Error('identity_after')}catch(e){failure=e&&['identity_before','identity_after'].includes(e.message)?'identity_mismatch':e&&e.message==='components'?'component_mismatch':'rpc_failed'}process.stdout.write(JSON.stringify({kind:'result',identityBefore,identityAfter,componentKeys,statusBefore,statusAfter,acknowledgement,observedAt:new Date().toISOString(),observer:{id:input.observer.id,host:os.hostname(),interfaceName:input.observer.interfaceName,interfaceAddress:address.address},writeAttempted,failure})+'\n')});
`
