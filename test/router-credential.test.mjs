import assert from 'node:assert/strict'
import test from 'node:test'
import { readQoderRouterKey } from '../src/router-credential.mjs'

test('reads only an unambiguous local Router provider',()=>{
 const read=()=>JSON.stringify({providers:{router:{model:'toolbox-spike',baseUrl:'http://127.0.0.1:18787/v1',apiKey:'synthetic-router-key'},upstream:{model:'other',baseUrl:'http://127.0.0.1:7770/v1',apiKey:'synthetic-upstream-key'}}})
 assert.equal(readQoderRouterKey({}, {read,home:'C:/example'}),'synthetic-router-key')
})
test('fails closed for absent, remote or ambiguous Router providers',()=>{
 const remote=()=>JSON.stringify({providers:{remote:{model:'toolbox-spike',baseUrl:'https://example.test/v1',apiKey:'synthetic'}}})
 const ambiguous=()=>JSON.stringify({providers:{a:{model:'toolbox-spike',baseUrl:'http://localhost:18787/v1',apiKey:'a'},b:{model:'toolbox-spike',baseUrl:'http://127.0.0.1:18787/v1',apiKey:'b'}}})
 assert.equal(readQoderRouterKey({}, {read:remote}), '')
 assert.equal(readQoderRouterKey({}, {read:ambiguous}), '')
 assert.equal(readQoderRouterKey({}, {read:()=>{throw new Error('missing')}}), '')
})
