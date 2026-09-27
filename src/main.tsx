import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

setTimeout(async () => {
  console.log("Renderer test: syncClipboard fromDevice");
  const result = await (window as any).electronAPI.syncClipboard('106293738O006649', 'fromDevice');
  console.log("Renderer test result:", result);
  console.log("Renderer test: done");
}, 5000);
