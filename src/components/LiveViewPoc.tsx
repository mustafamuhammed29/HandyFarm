import React, { useEffect, useRef, useState, useImperativeHandle } from 'react';
import { WebCodecsVideoDecoder, BitmapVideoFrameRenderer } from '@yume-chan/scrcpy-decoder-webcodecs';
import { ScrcpyVideoCodecId } from '@yume-chan/scrcpy';

import { ChevronLeft, Home, Square } from 'lucide-react';

export interface LiveViewPocRef {
  simulateTouch(action: number | string, xPercent: number | string, yPercent: number): void;
  sendKeyCode(keycode: number): void;
}

export const LiveViewPoc = React.forwardRef<LiveViewPocRef, { 
  deviceId: string,
  maxSize: number,
  videoBitRate: number,
  startDelayMs?: number,
  onMirrorTouch?: (action: number, xPercent: number, yPercent: number) => void,
  onMirrorKeyCode?: (keycode: number) => void
}>(({ deviceId, maxSize, videoBitRate, startDelayMs = 0, onMirrorTouch, onMirrorKeyCode }, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<string>('Idle');
  const [reconnectCounter, setReconnectCounter] = useState<number>(0);
  const pinchAnchorRef = useRef<{x: number, y: number} | null>(null);

  useEffect(() => {
    let isCancelled = false;

    const startStream = async () => {
      setStatus('Requesting stream...');
      try {
        const res = await (window as any).electronAPI.startLiveViewPoc(deviceId, maxSize, videoBitRate);
        if (isCancelled) {
          // If cancelled while requesting, stop immediately
          if (res.success) {
            (window as any).electronAPI.stopLiveViewPoc(deviceId);
          }
          return;
        }
        if (!res.success) {
          setStatus(`Error: ${res.error}`);
          console.warn(`[POC] Device ${deviceId} failed to start live view — check USB hub power/bandwidth. Error: ${res.error}`);
          return;
        }
        
        setStatus(`Connecting to WS on port ${res.port}...`);
        const ws = new WebSocket(`ws://127.0.0.1:${res.port}`);
        wsRef.current = ws;
        
        ws.binaryType = 'arraybuffer';
        
        const decoder = new WebCodecsVideoDecoder({
          codec: ScrcpyVideoCodecId.H264,
          renderer: new BitmapVideoFrameRenderer(canvasRef.current!)
        });
        
        const writer = decoder.writable.getWriter();

        ws.onopen = () => {
          setStatus('WS connected. Waiting for video data...');
        };

        let isLive = false;
        let pktCount = 0;
        ws.onmessage = (e) => {
          if (typeof e.data === 'string') {
            try {
              const msg = JSON.parse(e.data);
              if (msg.type === 'control-error') {
                setStatus(`${msg.error} (Reconnecting in 3s...)`);
                isLive = false;
                setTimeout(() => {
                  if (!isCancelled) setReconnectCounter(c => c + 1);
                }, 3000);
              }
            } catch (err) {}
            return;
          }

          if (!isLive) {
            isLive = true;
            setStatus('Live');
          }
          if (e.data instanceof ArrayBuffer) {
            pktCount++;
            if (pktCount % 30 === 0) {
              console.log(`[POC-RCV] Device ${deviceId} received ${pktCount} packets`);
            }
            const buffer = new Uint8Array(e.data);
            const header = buffer[0];
            const isConfig = (header & 1) !== 0;
            const isKeyframe = (header & 2) !== 0;
            
            const packetType = isConfig ? 'configuration' : 'data';
            
            const packet = {
              type: packetType,
              keyframe: isKeyframe,
              data: buffer.slice(1)
            };
            
            try {
              const writeResult = writer.write(packet as any);
              if (writeResult && writeResult.catch) {
                writeResult.catch((err: any) => {
                  console.error(`[POC-RCV] Decoder write error for ${deviceId}:`, err);
                  setStatus(`Decoder Error: ${err.message}`);
                });
              }
            } catch (err: any) {
              console.error(`[POC-RCV] Decoder synchronous write error for ${deviceId}:`, err);
              setStatus(`Decoder Error: ${err.message}`);
            }
          }
        };

        ws.onclose = () => {
          setStatus('WS closed.');
          if (wsRef.current === ws) {
            wsRef.current = null;
          }
        };

      } catch (e: any) {
        if (!isCancelled) {
          setStatus(`Error: ${e.message}`);
          console.warn(`[POC] Device ${deviceId} failed to start live view — check USB hub power/bandwidth. Exception: ${e.message}`);
        }
      }
    };

    // Delay start slightly to prevent React StrictMode double-mount collisions and stagger startup
    const timer = setTimeout(() => {
      if (!isCancelled) startStream();
    }, 250 + startDelayMs);

    return () => {
      isCancelled = true;
      clearTimeout(timer);
      if (wsRef.current) {
        wsRef.current.close();
      }
      (window as any).electronAPI.stopLiveViewPoc(deviceId);
    };
  }, [deviceId, maxSize, videoBitRate, startDelayMs, reconnectCounter]);

  useImperativeHandle(ref, () => ({
    simulateTouch(action: number | string, xPercent: number | string, yPercent: number) {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      if (action === 'text') {
        wsRef.current.send(JSON.stringify({ type: 'text', text: xPercent as string }));
        return;
      }
      const videoWidth = canvasRef.current?.width || 800;
      const videoHeight = canvasRef.current?.height || 600;
      const pointerX = (xPercent as number) * videoWidth;
      const pointerY = yPercent * videoHeight;

      const msg = {
        type: 'touch',
        action,
        x: pointerX,
        y: pointerY,
        videoWidth,
        videoHeight
      };
      wsRef.current.send(JSON.stringify(msg));
    },
    sendKeyCode(keycode: number) {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      wsRef.current.send(JSON.stringify({ type: 'keycode', keycode }));
    }
  }));

  const handlePointer = (e: React.PointerEvent<HTMLCanvasElement>, action: number) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    
    const rect = e.currentTarget.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;

    const videoWidth = e.currentTarget.width;
    const videoHeight = e.currentTarget.height;

    // object-fit: contain scale factor
    const scale = Math.min(rect.width / videoWidth, rect.height / videoHeight);
    
    // Size of the actual video rendered inside the canvas
    const renderedWidth = videoWidth * scale;
    const renderedHeight = videoHeight * scale;

    // Letterbox offsets
    const offsetX = (rect.width - renderedWidth) / 2;
    const offsetY = (rect.height - renderedHeight) / 2;

    // Relative position inside the rendered video area
    const videoX = Math.max(0, Math.min(cssX - offsetX, renderedWidth));
    const videoY = Math.max(0, Math.min(cssY - offsetY, renderedHeight));

    // Map to native video resolution
    const pointerX = (videoX / renderedWidth) * videoWidth;
    const pointerY = (videoY / renderedHeight) * videoHeight;

    if (e.altKey || e.ctrlKey || pinchAnchorRef.current) {
      if (action === 0) { // down
        pinchAnchorRef.current = { x: pointerX, y: pointerY };
        wsRef.current.send(JSON.stringify({ type: 'touch', action: 0, x: pointerX, y: pointerY, videoWidth, videoHeight, pointerId: 1 }));
        wsRef.current.send(JSON.stringify({ type: 'touch', action: 0, x: pointerX, y: pointerY, videoWidth, videoHeight, pointerId: 2 }));
      } else if (action === 2 && pinchAnchorRef.current) { // move
        wsRef.current.send(JSON.stringify({ type: 'touch', action: 2, x: pointerX, y: pointerY, videoWidth, videoHeight, pointerId: 2 }));
      } else if (action === 1 && pinchAnchorRef.current) { // up
        wsRef.current.send(JSON.stringify({ type: 'touch', action: 1, x: pointerX, y: pointerY, videoWidth, videoHeight, pointerId: 2 }));
        wsRef.current.send(JSON.stringify({ type: 'touch', action: 1, x: pinchAnchorRef.current.x, y: pinchAnchorRef.current.y, videoWidth, videoHeight, pointerId: 1 }));
        pinchAnchorRef.current = null;
      }
      return;
    }

    const msg = {
      type: 'touch',
      action, // 0: down, 1: up, 2: move
      x: pointerX,
      y: pointerY,
      videoWidth,
      videoHeight,
      pointerId: 1
    };
    wsRef.current.send(JSON.stringify(msg));

    if (onMirrorTouch) {
      onMirrorTouch(action, videoX / renderedWidth, videoY / renderedHeight);
    }
  };

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#000' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, padding: '4px 8px', background: 'rgba(0,0,0,0.5)', color: 'white', zIndex: 10, fontSize: '12px', display: 'flex', justifyContent: 'space-between', pointerEvents: 'none' }}>
        <span style={{ fontWeight: 'bold' }}>{deviceId}</span>
        <span style={{ color: status === 'Live' ? '#4ade80' : '#f87171' }}>{status}</span>
      </div>
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', overflow: 'hidden' }}>
        <canvas 
          ref={canvasRef} 
          style={{ width: '100%', height: '100%', objectFit: 'contain', cursor: 'crosshair', touchAction: 'none' }}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); handlePointer(e, 0); }}
          onPointerMove={(e) => { if (e.buttons > 0) handlePointer(e, 2); }}
          onPointerUp={(e) => { e.currentTarget.releasePointerCapture(e.pointerId); handlePointer(e, 1); }}
          onPointerCancel={(e) => { e.currentTarget.releasePointerCapture(e.pointerId); handlePointer(e, 1); }}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Enter') {
              if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                let text = e.key;
                if (e.key === 'Enter') text = '\n';
                else if (e.key === 'Backspace') text = '\b'; // Or handle specially
                
                wsRef.current.send(JSON.stringify({ type: 'text', text }));
                if (onMirrorTouch) {
                  (onMirrorTouch as any)('text', text, 0); // Hacky pass text via mirror
                }
              }
              e.preventDefault();
              e.stopPropagation();
            }
          }}
        />
      </div>
      <div style={{ height: '40px', display: 'flex', justifyContent: 'space-around', alignItems: 'center', background: '#1a1a1a', borderTop: '1px solid #333' }}>
        <button 
                    onClick={() => {
            const kc = 187;
            console.log(`[LiveViewPoc] Nav button ${kc} clicked!`);
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
              const payload = JSON.stringify({ type: 'keycode', keycode: kc });
              console.log(`[LiveViewPoc] Sending WebSocket payload:`, payload);
              wsRef.current.send(payload);
            } else {
              console.warn(`[LiveViewPoc] Cannot send keycode ${kc}, wsRef is missing or not OPEN`);
            }
            if (onMirrorKeyCode) onMirrorKeyCode(kc);
          }}
          style={{ padding: '6px', color: '#9ca3af', background: 'transparent', border: 'none', cursor: 'pointer' }}
          title="Recent Apps">
          <Square size={18} />
        </button>
        <button 
                    onClick={() => {
            const kc = 3;
            console.log(`[LiveViewPoc] Nav button ${kc} clicked!`);
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
              const payload = JSON.stringify({ type: 'keycode', keycode: kc });
              console.log(`[LiveViewPoc] Sending WebSocket payload:`, payload);
              wsRef.current.send(payload);
            } else {
              console.warn(`[LiveViewPoc] Cannot send keycode ${kc}, wsRef is missing or not OPEN`);
            }
            if (onMirrorKeyCode) onMirrorKeyCode(kc);
          }}
          style={{ padding: '6px', color: '#9ca3af', background: 'transparent', border: 'none', cursor: 'pointer' }}
          title="Home">
          <Home size={18} />
        </button>
        <button 
                    onClick={() => {
            const kc = 4;
            console.log(`[LiveViewPoc] Nav button ${kc} clicked!`);
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
              const payload = JSON.stringify({ type: 'keycode', keycode: kc });
              console.log(`[LiveViewPoc] Sending WebSocket payload:`, payload);
              wsRef.current.send(payload);
            } else {
              console.warn(`[LiveViewPoc] Cannot send keycode ${kc}, wsRef is missing or not OPEN`);
            }
            if (onMirrorKeyCode) onMirrorKeyCode(kc);
          }}
          style={{ padding: '6px', color: '#9ca3af', background: 'transparent', border: 'none', cursor: 'pointer' }}
          title="Back">
          <ChevronLeft size={22} />
        </button>
      </div>
    </div>
  );
});

