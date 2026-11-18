import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { t } from '../shared/i18n'
import { createAudioUploads } from './audioUpload'
export function hookAudioUploads(d:Omit<Parameters<typeof createAudioUploads>[0],'send'>&{window:()=>BrowserWindow|null|undefined; exiting:()=>boolean}) {
  const uploads=createAudioUploads({...d,send:(owner,token,status)=>{const win=d.window();if(win?.webContents.id===owner)win.webContents.send('audio-upload:status',token,status)}})
  d.store.interruptAudioPreparations()
  const cleaned=rm(join(d.root,'.uploads'),{recursive:true,force:true})
  const watched=new Map<number,number>()
  const owner=(e:IpcMainInvokeEvent)=>{if(e.sender!==d.window()?.webContents)throw new Error('Audio uploads belong to the main window');return e.sender.id}
  ipcMain.handle('audio-upload:pick',async e=>{
    const id=owner(e);await cleaned
    if(!watched.has(id)){
      watched.set(id,0)
      const cancel=()=>{if(d.exiting())return;watched.set(id,(watched.get(id)??0)+1);for(const token of uploads.tokens(id))void uploads.cancel(id,token).catch(error=>console.error('Audio upload cleanup failed',error))}
      e.sender.on('render-process-gone',cancel);e.sender.once('destroyed',()=>{cancel();watched.delete(id)})
      e.sender.on('did-start-navigation',(_event,_url,inPlace,mainFrame)=>{if(mainFrame&&!inPlace)cancel()})
    }
    const generation=watched.get(id)
    const result=await dialog.showOpenDialog(d.window()!,{properties:['openFile'],filters:[{name:t('Audio'),extensions:['mp3','m4a','wav']}]})
    return watched.get(id)!==generation||result.canceled||!result.filePaths[0]?null:uploads.select(id,result.filePaths[0])
  })
  ipcMain.handle('audio-upload:info',(e,token)=>uploads.info(owner(e),token))
  ipcMain.handle('audio-upload:start',(e,token,title,at)=>uploads.start(owner(e),token,title,at))
  ipcMain.handle('audio-upload:read',(e,token,offset,length)=>uploads.read(owner(e),token,offset,length))
  ipcMain.handle('audio-upload:write',(e,token,samples,fraction)=>uploads.write(owner(e),token,samples,fraction))
  ipcMain.handle('audio-upload:finish',(e,token)=>uploads.finish(owner(e),token))
  ipcMain.handle('audio-upload:failed',(e,token,error)=>uploads.failed(owner(e),token,error))
  ipcMain.handle('audio-upload:cancel',(e,token)=>uploads.cancel(owner(e),token))
  return uploads
}
