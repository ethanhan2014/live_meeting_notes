const fs=require('node:fs/promises');
const path=require('node:path');
async function prepare(){
 const [major,minor]=process.versions.node.split('.').map(Number);
 if(major<22||major===22&&minor<12)throw new Error('Build with Node.js 22.12 or later.');
 const root=path.resolve(__dirname,'..'),runtime=path.join(root,'resources','runtime');
 await fs.rm(runtime,{recursive:true,force:true});await fs.mkdir(runtime,{recursive:true});
 for(const name of ['main.cjs','lib','schemas','python','LICENSE','THIRD-PARTY-NOTICES.txt'])await fs.cp(path.join(root,name),path.join(runtime,name),{recursive:true,filter:source=>!source.includes('__pycache__')});
 try{await fs.copyFile(path.join(root,'resources','default.env'),path.join(runtime,'.env'));await fs.chmod(path.join(runtime,'.env'),0o600);}catch(error){if(error.code!=='ENOENT')throw error;}
 const node=path.join(runtime,process.platform==='win32'?'node.exe':'node');await fs.copyFile(process.execPath,node);await fs.chmod(node,0o755);
 const license=await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`,{signal:AbortSignal.timeout(30000)});
 if(!license.ok)throw new Error('Could not retrieve the bundled Node runtime license.');
 await fs.writeFile(path.join(runtime,'Node-LICENSE'),await license.text());
 await fs.writeFile(path.join(runtime,'manifest.json'),JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,engine:'whisperx',pythonBundled:false},null,2)+'\n');
 console.log('Prepared Tauri backend and Node runtime. Python/WhisperX must be installed separately.');
}
prepare().catch(error=>{console.error(error.message);process.exitCode=1;});
