import React, { useEffect, useState, useRef } from 'react';
import { Play, Square, Download, Trash2, Search } from 'lucide-react';

export const LogcatViewer: React.FC<{ deviceId: string, onClose: () => void }> = ({ deviceId, onClose }) => {
  const [logs, setLogs] = useState<string[]>([]);
  const [isStreaming, setIsStreaming] = useState(true);
  const [filterText, setFilterText] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const logsEndRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    if (isStreaming) {
      window.electronAPI.startLogcat(deviceId);
      window.electronAPI.onLogcatData(deviceId, (data) => {
        setLogs(prev => {
          const lines = data.split('\n').filter(l => l.trim().length > 0);
          const newLogs = [...prev, ...lines];
          // Keep last 5000 lines
          if (newLogs.length > 5000) {
            return newLogs.slice(newLogs.length - 5000);
          }
          return newLogs;
        });
      });
    } else {
      window.electronAPI.stopLogcat(deviceId);
      window.electronAPI.offLogcatData(deviceId);
    }
    
    return () => {
      window.electronAPI.stopLogcat(deviceId);
      window.electronAPI.offLogcatData(deviceId);
    };
  }, [deviceId, isStreaming]);

  useEffect(() => {
    if (autoScroll && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'auto' });
    }
  }, [logs, autoScroll]);

  const filteredLogs = filterText 
    ? logs.filter(l => l.toLowerCase().includes(filterText.toLowerCase()))
    : logs;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()} style={{ width: '900px', maxWidth: '95vw', height: '80vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h3 style={{ margin: 0 }}>Logcat: {deviceId}</h3>
          
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <Search size={16} style={{ position: 'absolute', left: '8px', color: 'var(--text-muted)' }} />
              <input 
                type="text" 
                placeholder="Filter logs..." 
                value={filterText}
                onChange={e => setFilterText(e.target.value)}
                style={{ paddingLeft: '32px', width: '200px' }}
              />
            </div>
            
            <button className={`icon-btn ${isStreaming ? 'danger' : 'primary'}`} onClick={() => setIsStreaming(!isStreaming)} title={isStreaming ? "Stop" : "Resume"}>
              {isStreaming ? <Square size={18} /> : <Play size={18} />}
            </button>
            <button className="icon-btn" onClick={() => setLogs([])} title="Clear">
              <Trash2 size={18} />
            </button>
            <button className="icon-btn" onClick={() => {
              const blob = new Blob([logs.join('\n')], { type: 'text/plain' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `logcat_${deviceId}_${Date.now()}.txt`;
              a.click();
            }} title="Download">
              <Download size={18} />
            </button>
            <button className="primary-btn" onClick={onClose}>Close</button>
          </div>
        </div>
        
        <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', cursor: 'pointer' }}>
            <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} />
            Auto-scroll
          </label>
        </div>

        <div 
          style={{ 
            flex: 1, 
            background: '#000', 
            color: '#0f0', 
            fontFamily: 'monospace', 
            fontSize: '12px',
            padding: '12px', 
            borderRadius: '8px', 
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all'
          }}
          onScroll={(e) => {
             const target = e.target as HTMLDivElement;
             const isAtBottom = Math.abs(target.scrollHeight - target.scrollTop - target.clientHeight) < 50;
             if (autoScroll && !isAtBottom) setAutoScroll(false);
          }}
        >
          {filteredLogs.map((line, i) => (
            <div key={i} style={{ 
              color: line.includes(' E ') ? '#ff5555' : 
                     line.includes(' W ') ? '#ffb86c' : 
                     line.includes(' I ') ? '#8be9fd' : 
                     line.includes(' D ') ? '#50fa7b' : '#f8f8f2',
              marginBottom: '2px',
              borderBottom: '1px solid #222'
            }}>
              {line}
            </div>
          ))}
          <div ref={logsEndRef} />
        </div>
      </div>
    </div>
  );
};
