const {test}=require('node:test');
const assert=require('node:assert/strict');
const {assertArm64MachO}=require('../scripts/release-macos.cjs');
test('Mac release rejects Intel and malformed binaries before publishing',()=>{
 const bytes=Buffer.alloc(32);bytes.writeUInt32LE(0xfeedfacf,0);bytes.writeUInt32LE(0x100000c,4);
 assert.doesNotThrow(()=>assertArm64MachO(bytes));
 bytes.writeUInt32LE(0x1000007,4);assert.throws(()=>assertArm64MachO(bytes),/Apple Silicon/);
 assert.throws(()=>assertArm64MachO(Buffer.alloc(8)),/Mach-O/);
});
