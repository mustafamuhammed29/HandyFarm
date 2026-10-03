import { useEffect, useState, useRef, useCallback } from 'react';
import { 
  Smartphone, XCircle, Play, CheckSquare, Square, RefreshCw, Link as LinkIcon, Download, 
  Moon, Sun, Pin, PinOff, Settings, Search, 
  Terminal, Power, FileUp, FileDown, Save, Key, History, Copy, Wifi
} from 'lucide-react';
import './App.css';
import type { DeviceData, QuickPhrase, TestAccount } from './types';
import { LiveViewPoc } from './components/LiveViewPoc';
import type { LiveViewPocRef } from './components/LiveViewPoc';

function App() {
  const [devices, setDevices] = useState<DeviceData[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [actionInProgress, setActionInProgress] = useState(false);
  const [results, setResults] = useState<{deviceId: string, success: boolean, error?: string, action: string}[] | null>(null);
  
  const [focusedDeviceId, setFocusedDeviceId] = useState<string | null>(null);
  const [sidebarPinned, setSidebarPinned] = useState(true);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [searchQuery, setSearchQuery] = useState('');
  const [isMirrorMode, setIsMirrorMode] = useState(false);
  const liveViewRefs = useRef<{ [key: string]: LiveViewPocRef | null }>({});
  const [gridDensity, setGridDensity] = useState<'compact' | 'normal' | 'large'>(
    (localStorage.getItem('gridDensity') as any) || 'large'
  );
  const [zoomLevel, setZoomLevel] = useState<number>(
    parseFloat(localStorage.getItem('gridZoom') || '1')
  );

  useEffect(() => {
    localStorage.setItem('gridDensity', gridDensity);
    localStorage.setItem('gridZoom', zoomLevel.toString());
  }, [gridDensity, zoomLevel]);

  // Phase 7 state
  const [activeTagFilter, setActiveTagFilter] = useState('');
  const [allTags, setAllTags] = useState<string[]>([]);
  const [showAdbConsole, setShowAdbConsole] = useState(false);
  const [adbCommand, setAdbCommand] = useState('');
  const [adbOutput, setAdbOutput] = useState('');
  const [batchDelay, setBatchDelay] = useState(0);
  const [textToSend, setTextToSend] = useState('');
  const [appPackageName, setAppPackageName] = useState('');
  const [quickPhrases, setQuickPhrases] = useState<QuickPhrase[]>([]);
  const [testAccounts, setTestAccounts] = useState<TestAccount[]>([]);
  const [showAccountsModal, setShowAccountsModal] = useState(false);
  const [newAccountInput, setNewAccountInput] = useState('');
  
  // Phase 7 Distinct Distribution State
  const [showDistributionModal, setShowDistributionModal] = useState(false);
  const [distributionMapping, setDistributionMapping] = useState<{deviceId: string, textLine: string}[]>([]);
  
  const [singleTargetId, setSingleTargetId] = useState('');
  const [singleTargetText, setSingleTargetText] = useState('');
  
  const [apkPath, setApkPath] = useState('');
  const [url, setUrl] = useState('');
  const [globalMessage, setGlobalMessage] = useState('');
  const [confirmDialog, setConfirmDialog] = useState<{msg: string, onConfirm: () => void} | null>(null);
  
  const [discoveredDevices, setDiscoveredDevices] = useState<{name: string, ip: string, serial?: string}[]>([]);

  // Settings Modal
  const [settingsDevice, setSettingsDevice] = useState<DeviceData | null>(null);
  const [settingsForm, setSettingsForm] = useState({ customName: '', notes: '', isBareBoard: false, tags: '' });
  const [historyDevice, setHistoryDevice] = useState<DeviceData | null>(null);

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme') as 'dark' | 'light' | null;
    if (savedTheme) setTheme(savedTheme);
    const savedPhrases = localStorage.getItem('quickPhrases');
    if (savedPhrases) setQuickPhrases(JSON.parse(savedPhrases));
    const savedAccounts = localStorage.getItem('testAccounts');
    if (savedAccounts) {
      const parsed = JSON.parse(savedAccounts) as TestAccount[];
      let migratedCount = 0;
      let needsSave = false;

      Promise.all(parsed.map(async (acc) => {
        if (acc.password) {
          const res = await window.electronAPI.saveTestAccountPassword(acc.id, acc.password);
          if (!res.success) {
            setGlobalMessage(`Migration failed for account ${acc.id}: ${res.error}`);
            // Do not delete password if migration failed
          } else {
            delete acc.password;
            migratedCount++;
            needsSave = true;
          }
        }
      })).then(() => {
        if (needsSave) {
          console.log(`Migrated ${migratedCount} accounts to secure storage.`);
          localStorage.setItem('testAccounts', JSON.stringify(parsed));
        }
        setTestAccounts(parsed);
      });
    } else {
      // Default initial mock accounts if none exist
      const defaultAccounts = [
        { id: '1', label: 'QA User 1', username: 'test1@handyland.internal' },
        { id: '2', label: 'QA User 2', username: 'test2@handyland.internal' }
      ];
      setTestAccounts(defaultAccounts);
      localStorage.setItem('testAccounts', JSON.stringify(defaultAccounts));
    }
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
    let interval: any;
    const fetchMdns = async () => {
      const result = await window.electronAPI.scanMdns();
      if (result) setDiscoveredDevices(result);
    };
    fetchMdns();
    interval = setInterval(fetchMdns, 15000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    window.electronAPI.getDevices().then(setDevices);
    window.electronAPI.onDevicesUpdated((updatedDevices) => {
      setDevices(updatedDevices);
      // Extract all unique tags
      const tags = new Set<string>();
      updatedDevices.forEach(d => d.tags?.forEach(t => tags.add(t)));
      setAllTags(Array.from(tags));
    });
  }, []);

  const toggleTheme = () => setTheme(t => t === 'dark' ? 'light' : 'dark');
  const toggleSidebar = () => setSidebarPinned(p => !p);

  const getFilteredDevices = () => {
    // Hide fully offline devices, and devices that haven't been resolved yet (no serial or undefined status)
    let filtered = devices.filter(d => 
      d.status !== 'offline' && 
      d.status !== 'disconnect' && 
      d.status !== undefined && 
      d.status !== 'undefined' &&
      d.serial // Only show devices that have successfully fetched their properties
    );
    
    if (activeTagFilter) {
      filtered = filtered.filter(d => d.tags?.includes(activeTagFilter));
    }
    if (searchQuery) {
      const lowerQ = searchQuery.toLowerCase();
      filtered = filtered.filter(d => 
        (d.customName && d.customName.toLowerCase().includes(lowerQ)) ||
        (d.name && d.name.toLowerCase().includes(lowerQ)) ||
        (d.model && d.model.toLowerCase().includes(lowerQ)) ||
        (d.status && d.status.toLowerCase().includes(lowerQ)) ||
        (d.serial && d.serial.toLowerCase().includes(lowerQ))
      );
    }
    return filtered;
  };

  const visibleDevices = getFilteredDevices().sort((a, b) => {
    const tA = a.connectedAt || 0;
    const tB = b.connectedAt || 0;
    return tA - tB;
  });
  const activeDeviceCount = new Set(devices.filter(d => d.status === 'device').map(d => d.serial || d.id)).size;
  let currentMaxSize = 800;
  let currentVideoBitRate = 2000000;
  if (activeDeviceCount >= 11) {
    currentMaxSize = 320;
    currentVideoBitRate = 500000;
  } else if (activeDeviceCount >= 5) {
    currentMaxSize = 480;
    currentVideoBitRate = 1000000;
  }

  const handleMirrorTouch = useCallback((sourceId: string, action: number, px: number, py: number) => {
    if (isMirrorMode && selectedIds.has(sourceId)) {
      selectedIds.forEach(id => {
        if (id !== sourceId && liveViewRefs.current[id]) {
          liveViewRefs.current[id]!.simulateTouch(action, px, py);
        }
      });
    }
  }, [isMirrorMode, selectedIds]);

  const handleMirrorKeyCode = useCallback((sourceId: string, keycode: number) => {
    if (isMirrorMode && selectedIds.has(sourceId)) {
      selectedIds.forEach(id => {
        if (id !== sourceId && liveViewRefs.current[id]) {
          liveViewRefs.current[id]!.sendKeyCode(keycode);
        }
      });
    }
  }, [isMirrorMode, selectedIds]);

  const handleSwitchToWireless = async (deviceId: string) => {
    setActionInProgress(true);
    const res = await window.electronAPI.switchToWireless(deviceId);
    setActionInProgress(false);
    if (!res.success) {
      alert(`Failed to switch to wireless: ${res.error}`);
    } else {
      alert(`Successfully switched device ${deviceId} to Wireless ADB at ${res.ip}:5555. You can now unplug the USB cable.`);
    }
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === visibleDevices.length && visibleDevices.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(visibleDevices.map(d => d.id)));
    }
  };

  const toggleDeviceSelect = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const newSet = new Set(selectedIds);
    // Ctrl+Click handling (already standard behavior for this checkbox, but enforced logic)
    if (newSet.has(id)) newSet.delete(id);
    else newSet.add(id);
    setSelectedIds(newSet);
  };



  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  // Action Runner handles batching and Alt+Click single-target override
  const executeBulkAction = async (action: string, payload?: any, e?: React.MouseEvent) => {
    let targetIds = Array.from(selectedIds);
    
    // Alt+Click logic: run only on focused device if it exists
    if (e && e.altKey && focusedDeviceId) {
      targetIds = [focusedDeviceId];
    } else if (targetIds.length === 0) {
      return;
    }

    if (action === 'reboot' && !e?.altKey) {
      setConfirmDialog({
        msg: `Reboot ${targetIds.length} device(s)?`,
        onConfirm: () => executeBulkAction(action, payload, { ...e, altKey: true } as any) // pass altKey to skip confirm next time
      });
      return;
    }

    setActionInProgress(true);
    setResults(null);
    const newResults: any[] = [];
    
    for (let i = 0; i < targetIds.length; i++) {
      const id = targetIds[i];
      let res;
      try {
        switch (action) {
          case 'reboot': res = await window.electronAPI.rebootDevice(id); break;
          case 'openLink': res = await window.electronAPI.openLink(id, payload); break;
          case 'installApk': res = await window.electronAPI.installApk(id, payload); break;
          case 'sendText': res = await window.electronAPI.sendText(id, payload); break;
          case 'launchApp': res = await window.electronAPI.launchApp(id, payload); break;
          case 'clearCache': res = await window.electronAPI.clearAppCache(id, payload); break;
          case 'settings': res = await window.electronAPI.openSettings(id, payload); break;
          default: res = { success: false, error: 'Unknown action' };
        }
      } catch (err: any) {
        res = { success: false, error: err.message };
      }
      newResults.push({ deviceId: id, success: res?.success || false, error: res?.error, action });
      
      // Jitter / Micro-delay
      if (batchDelay > 0 && i < targetIds.length - 1) {
        const jitter = Math.random() * batchDelay;
        await sleep(batchDelay + jitter);
      }
    }

    setResults(newResults);
    setActionInProgress(false);
  };

  const executeSingleTarget = async (deviceId: string, text: string) => {
     if (!deviceId || !text) return;
     setActionInProgress(true);
     setResults(null);
     try {
       const res = await window.electronAPI.sendText(deviceId, text);
       setResults([{ deviceId, success: res.success, error: res.error, action: 'sendText' }]);
     } catch (e: any) {
       setResults([{ deviceId, success: false, error: e.message, action: 'sendText' }]);
     }
     setActionInProgress(false);
  };

  const executeDistribution = async () => {
    setActionInProgress(true);
    setResults(null);
    setShowDistributionModal(false);
    const newResults: any[] = [];
    
    for (let i = 0; i < distributionMapping.length; i++) {
      const { deviceId, textLine } = distributionMapping[i];
      if (!textLine) continue; // Skip if no assigned text
      try {
        const res = await window.electronAPI.sendText(deviceId, textLine);
        newResults.push({ deviceId, success: res.success, error: res.error, action: 'sendText' });
      } catch (err: any) {
        newResults.push({ deviceId, success: false, error: err.message, action: 'sendText' });
      }
      
      // Delay
      if (batchDelay > 0 && i < distributionMapping.length - 1) {
        const jitter = Math.random() * batchDelay;
        await sleep(batchDelay + jitter);
      }
    }
    setResults(newResults);
    setActionInProgress(false);
  };

  const openSettings = (device: DeviceData, e: React.MouseEvent) => {
    e.stopPropagation();
    setSettingsDevice(device);
    setSettingsForm({
      customName: device.customName || '',
      notes: device.notes || '',
      isBareBoard: !!device.isBareBoard,
      tags: device.tags ? device.tags.join(', ') : ''
    });
  };

  const saveSettings = () => {
    if (settingsDevice) {
      const tagsArray = settingsForm.tags.split(',').map(t => t.trim()).filter(t => t.length > 0);
      window.electronAPI.updateDeviceData(settingsDevice.id, {
        customName: settingsForm.customName,
        notes: settingsForm.notes,
        isBareBoard: settingsForm.isBareBoard,
        tags: tagsArray
      });
    }
    setSettingsDevice(null);
  };

  const handleExport = async () => {
    const res = await window.electronAPI.exportConfig();
    if (res.success) setGlobalMessage(`Exported to ${res.path}`);
  };

  const handleImport = async () => {
    const res = await window.electronAPI.importConfig();
    if (res.success) setGlobalMessage(`Import successful!`);
  };

  const runAdbCommand = async () => {
    if (!focusedDeviceId || !adbCommand) return;
    setAdbOutput('Running...');
    const res = await window.electronAPI.runAdbCommand(focusedDeviceId, adbCommand);
    setAdbOutput(res.output || res.error || 'Done.');
  };

  return (
    <div className={`app-container ${theme}`}>
      {!sidebarPinned && <div className="sidebar-trigger" />}
      <aside className={`sidebar ${!sidebarPinned ? 'auto-hide' : ''}`}>
        <div className="sidebar-header">
          <div className="sidebar-title">
            <h1>Control Panel</h1>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="icon-btn" onClick={toggleTheme} title="Toggle Theme">
                {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
              </button>
              <button className={`icon-btn ${sidebarPinned ? 'active' : ''}`} onClick={toggleSidebar} title={sidebarPinned ? 'Unpin Sidebar' : 'Pin Sidebar'}>
                {sidebarPinned ? <Pin size={20} /> : <PinOff size={20} />}
              </button>
            </div>
          </div>
          <div className="search-container">
            <Search size={16} className="search-icon" />
            <input 
              type="text" 
              placeholder="Search devices..." 
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>
          {allTags.length > 0 && (
            <div className="tag-filter">
              <select value={activeTagFilter} onChange={e => setActiveTagFilter(e.target.value)} style={{width: '100%', padding: '8px', borderRadius: '8px', background: 'var(--bg-color)', color: 'var(--text-main)', border: '1px solid var(--border)'}}>
                <option value="">All Tags (No Filter)</option>
                {allTags.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          )}
        </div>

        <div className="sidebar-content">
          <div className="action-section">
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
              <h3>Selection ({selectedIds.size})</h3>
              <span style={{fontSize:'11px', color:'var(--text-muted)'}}>Alt+Click = Focused Only</span>
            </div>
            <div style={{display: 'flex', gap: '8px', marginTop: '8px'}}>
              <button className="large-btn" style={{flex: 1}} onClick={toggleSelectAll}>
                {selectedIds.size === visibleDevices.length && visibleDevices.length > 0 ? <CheckSquare size={20} className="text-accent" /> : <Square size={20} />}
                {selectedIds.size === visibleDevices.length && visibleDevices.length > 0 ? 'Deselect All' : 'Select All'}
              </button>
              

              <button 
                className={`large-btn ${isMirrorMode ? 'primary' : ''}`}  
                style={{flex: 1}} 
                onClick={() => setIsMirrorMode(!isMirrorMode)}
              >
                <Copy size={20} />
                Mirror Input {isMirrorMode ? 'ON' : 'OFF'}
              </button>
            </div>
            
            <div style={{display: 'flex', gap: '8px', marginTop: '8px'}}>
              <button className="large-btn" style={{flex: 1, padding: '8px', fontSize: '14px', justifyContent: 'center'}} onClick={handleImport} title="Import Config"><FileDown size={16}/> Import</button>
              <button className="large-btn" style={{flex: 1, padding: '8px', fontSize: '14px', justifyContent: 'center'}} onClick={handleExport} title="Export Config"><FileUp size={16}/> Export</button>
            </div>
          </div>

          <div className="action-section">
            <h3>Batch App & Files</h3>
            <div style={{display: 'flex', gap: '8px', background: 'var(--bg-color)', padding: '8px', borderRadius: '8px'}}>
              <input type="text" placeholder="APK Path" value={apkPath} onChange={e => setApkPath(e.target.value)} style={{flex: 1, padding: '8px', border: '1px solid var(--border)', borderRadius: '4px', background: 'var(--card-bg)', color: 'var(--text-main)'}} />
              <button className="icon-btn active" disabled={actionInProgress || !apkPath} onClick={(e) => executeBulkAction('installApk', apkPath, e)} title="Install APK">
                <Download size={18} />
              </button>
            </div>
            <div style={{display: 'flex', gap: '8px', background: 'var(--bg-color)', padding: '8px', borderRadius: '8px', marginTop: '8px'}}>
              <input type="text" placeholder="URL" value={url} onChange={e => setUrl(e.target.value)} style={{flex: 1, padding: '8px', border: '1px solid var(--border)', borderRadius: '4px', background: 'var(--card-bg)', color: 'var(--text-main)'}} />
              <button className="icon-btn active" disabled={actionInProgress || !url} onClick={(e) => executeBulkAction('openLink', url, e)} title="Open Link">
                <LinkIcon size={18} />
              </button>
            </div>
            <div style={{display: 'flex', gap: '8px', background: 'var(--bg-color)', padding: '8px', borderRadius: '8px'}}>
              <input type="text" placeholder="Package name" value={appPackageName} onChange={e => setAppPackageName(e.target.value)} style={{flex: 1, padding: '8px', border: '1px solid var(--border)', borderRadius: '4px', background: 'var(--card-bg)', color: 'var(--text-main)'}} />
              <button className="icon-btn active" onClick={(e) => executeBulkAction('launchApp', appPackageName, e)} title="Launch App"><Play size={18}/></button>
              <button className="icon-btn active" onClick={(e) => executeBulkAction('clearCache', appPackageName, e)} title="Clear Cache"><RefreshCw size={18}/></button>
            </div>
          </div>

          <div className="action-section">
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
              <h3>Batch Data Input</h3>
            </div>
            <div style={{fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px'}}>
              * Note: Bulk actions send the <strong>identical</strong> content to all selected devices. For distinct per-device content, use <strong>"Distribute from File"</strong> below, or the <strong>Single Device Target</strong> tool.
            </div>
            <div style={{display: 'flex', flexDirection: 'column', gap: '8px', background: 'var(--bg-color)', padding: '12px', borderRadius: '8px'}}>
              <input type="text" placeholder="Text to send..." value={textToSend} onChange={e => setTextToSend(e.target.value)} style={{padding: '8px', border: '1px solid var(--border)', borderRadius: '4px', background: 'var(--card-bg)', color: 'var(--text-main)'}} />
              <div style={{display: 'flex', gap: '8px'}}>
                <button className="large-btn primary" style={{flex: 1, padding: '8px', fontSize: '14px', justifyContent: 'center'}} onClick={(e) => executeBulkAction('sendText', textToSend, e)}>Send Text</button>
                <button className="large-btn" style={{flex: 1, padding: '8px', fontSize: '14px', justifyContent: 'center'}} onClick={() => {
                  if(textToSend) {
                    const newP = [...quickPhrases, {id: Date.now().toString(), label: textToSend.substring(0, 10), text: textToSend}];
                    setQuickPhrases(newP);
                    localStorage.setItem('quickPhrases', JSON.stringify(newP));
                  }
                }}><Save size={16}/> Save</button>
              </div>
              {quickPhrases.length > 0 && (
                <select onChange={(e) => setTextToSend(e.target.value)} style={{padding: '8px', borderRadius: '4px', background: 'var(--card-bg)', color: 'var(--text-main)', border: '1px solid var(--border)'}}>
                  <option value="">-- Quick Phrases --</option>
                  {quickPhrases.map(p => <option key={p.id} value={p.text}>{p.label}</option>)}
                </select>
              )}
              
              <div style={{display: 'flex', gap: '8px', marginTop: '4px'}}>
                <label className="large-btn" style={{flex: 1, padding: '8px', fontSize: '14px', justifyContent: 'center', cursor: 'pointer', background: 'var(--card-bg)'}}>
                  <FileUp size={16}/> Distribute from File (.txt)
                  <input type="file" accept=".txt,.csv" style={{display: 'none'}} onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    if (selectedIds.size === 0) {
                      setGlobalMessage("Please select target devices first.");
                      return;
                    }
                    const reader = new FileReader();
                    reader.onload = (evt) => {
                      const text = evt.target?.result as string;
                      const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
                      const selectedArray = visibleDevices.filter(d => selectedIds.has(d.id));
                      const initialMapping = selectedArray.map((dev, idx) => ({
                        deviceId: dev.id,
                        textLine: lines[idx] || ''
                      }));
                      setDistributionMapping(initialMapping);
                      setShowDistributionModal(true);
                      e.target.value = ''; // reset
                    };
                    reader.readAsText(file);
                  }} />
                </label>
              </div>
            </div>

            <div style={{display: 'flex', flexDirection: 'column', gap: '8px', background: 'rgba(139, 92, 246, 0.1)', border: '1px solid #8b5cf6', padding: '12px', borderRadius: '8px'}}>
              <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
                <span style={{fontSize: '12px', fontWeight: 'bold', color: '#8b5cf6'}}>INTERNAL HANDYLAND ACCOUNTS</span>
                <button className="icon-btn" style={{padding: '2px', color: '#8b5cf6'}} onClick={() => setShowAccountsModal(true)} title="Manage Accounts">
                  <Settings size={14}/>
                </button>
              </div>
              <select id="testAccountSelect" style={{padding: '8px', borderRadius: '4px', background: 'var(--card-bg)', color: 'var(--text-main)', border: '1px solid var(--border)'}}>
                {testAccounts.map(a => <option key={a.id} value={a.username}>{a.label || a.username}</option>)}
              </select>
              <button className="large-btn" style={{padding: '8px', fontSize: '14px', justifyContent: 'center'}} onClick={(e) => {
                const val = (document.getElementById('testAccountSelect') as HTMLSelectElement).value;
                executeBulkAction('sendText', val, e);
              }}><Key size={16}/> Inject Username</button>
            </div>
          </div>
          
          <div className="action-section">
            <h3>Quick Intents</h3>
            <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px'}}>
              <button className="large-btn" style={{padding: '8px', fontSize: '14px', justifyContent: 'center'}} onClick={(e) => executeBulkAction('settings', 'wifi', e)}>Wi-Fi</button>
              <button className="large-btn" style={{padding: '8px', fontSize: '14px', justifyContent: 'center'}} onClick={(e) => executeBulkAction('settings', 'ime', e)}>Keyboard</button>
              <button className="large-btn" style={{padding: '8px', fontSize: '14px', justifyContent: 'center'}} onClick={(e) => executeBulkAction('settings', 'accessibility', e)}>Access</button>
              <button className="large-btn danger" style={{padding: '8px', fontSize: '14px', justifyContent: 'center'}} onClick={(e) => executeBulkAction('reboot', null, e)}><Power size={16}/> Reboot</button>
            </div>
            
            <div style={{display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px'}}>
              <span style={{fontSize: '12px', color: 'var(--text-muted)'}}>Action Delay (ms):</span>
              <input type="number" value={batchDelay} onChange={e => setBatchDelay(parseInt(e.target.value) || 0)} style={{width: '60px', padding: '4px', background: 'var(--bg-color)', color: 'var(--text-main)', border: '1px solid var(--border)', borderRadius: '4px'}} />
            </div>
          </div>

          <div className="action-section">
            <h3>Single Device Target</h3>
            <div style={{display: 'flex', flexDirection: 'column', gap: '8px', background: 'var(--bg-color)', padding: '12px', borderRadius: '8px'}}>
              <select value={singleTargetId} onChange={e => setSingleTargetId(e.target.value)} style={{padding: '8px', borderRadius: '4px', background: 'var(--card-bg)', color: 'var(--text-main)', border: '1px solid var(--border)'}}>
                <option value="">-- Select a specific device --</option>
                {visibleDevices.map(d => <option key={d.id} value={d.id}>{d.customName || d.name || d.model} ({d.id})</option>)}
              </select>
              <input type="text" placeholder="Text to send..." value={singleTargetText} onChange={e => setSingleTargetText(e.target.value)} style={{padding: '8px', border: '1px solid var(--border)', borderRadius: '4px', background: 'var(--card-bg)', color: 'var(--text-main)'}} />
              <button className="large-btn primary" disabled={!singleTargetId || !singleTargetText || actionInProgress} style={{padding: '8px', fontSize: '14px', justifyContent: 'center'}} onClick={() => executeSingleTarget(singleTargetId, singleTargetText)}>Send to this device only</button>
            </div>
          </div>

        </div>
      </aside>

      <main className="main-content">
        <div className="strip-header" style={{ padding: '16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={{ margin: 0 }}>Live Grid ({activeDeviceCount} Active, {currentMaxSize}p@{currentVideoBitRate/1000}Kbps)</h2>
            <div className="strip-stats" style={{ marginTop: '4px' }}>
              <span><strong style={{color: 'var(--status-green)'}}>{activeDeviceCount}</strong> Online</span>
              <span><strong style={{color: 'var(--status-red)'}}>{devices.filter(d => d.status === 'offline').length}</strong> Offline</span>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: '4px', overflow: 'hidden' }}>
              <button 
                className={gridDensity === 'compact' ? 'primary-btn' : 'secondary-btn'} 
                style={{ border: 'none', borderRadius: 0, padding: '4px 8px', fontSize: '12px' }}
                onClick={() => setGridDensity('compact')}
              >Compact</button>
              <button 
                className={gridDensity === 'normal' ? 'primary-btn' : 'secondary-btn'} 
                style={{ border: 'none', borderRadius: 0, borderLeft: '1px solid var(--border)', padding: '4px 8px', fontSize: '12px' }}
                onClick={() => setGridDensity('normal')}
              >Normal</button>
              <button 
                className={gridDensity === 'large' ? 'primary-btn' : 'secondary-btn'} 
                style={{ border: 'none', borderRadius: 0, borderLeft: '1px solid var(--border)', padding: '4px 8px', fontSize: '12px' }}
                onClick={() => setGridDensity('large')}
              >Large</button>
            </div>
            
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>Tile Zoom:</span>
              <input 
                type="range" 
                min="0.5" 
                max="2.5" 
                step="0.1" 
                value={zoomLevel} 
                onChange={e => setZoomLevel(parseFloat(e.target.value))} 
                style={{ width: '100px' }}
              />
              <span style={{ fontSize: '14px', minWidth: '40px' }}>{Math.round(zoomLevel * 100)}%</span>
            </div>
          </div>
        </div>
        
        <div className="focused-view" style={{ 
          display: 'grid', 
          gridTemplateColumns: `repeat(auto-fill, ${Math.floor((gridDensity === 'compact' ? 200 : gridDensity === 'normal' ? 280 : 380) * zoomLevel)}px)`, 
          gap: '16px', 
          padding: '16px', 
          overflowY: 'auto', 
          alignContent: 'start', 
          justifyContent: 'start' 
        }}>
          {visibleDevices.map((device, index) => {
            const isSelected = selectedIds.has(device.id);
            const isDevice = device.status === 'device';
            
            let statusColor = 'gray';
            if (isDevice) statusColor = 'green';
            else if (device.status === 'offline') statusColor = 'red';
            else if (device.status === 'unauthorized') statusColor = 'yellow';

            const tileSizes = {
              compact: { w: 200, h: 380 },
              normal: { w: 280, h: 520 },
              large: { w: 380, h: 700 }
            };
            const currentSize = tileSizes[gridDensity];

            return (
              <div 
                key={device.id} 
                className={`thumb-card ${isSelected ? 'selected' : ''}`} 
                style={{ 
                  width: `${Math.floor(currentSize.w * zoomLevel)}px`,
                  height: `${Math.floor(currentSize.h * zoomLevel)}px`,
                  display: 'flex', 
                  flexDirection: 'column',
                  background: 'var(--bg-dark)'
                }}
              >
                <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 20, cursor: 'pointer' }} onClick={(e) => toggleDeviceSelect(device.id, e)}>
                  {isSelected ? <CheckSquare size={gridDensity === 'compact' ? 16 : 24} color="var(--accent)" /> : <Square size={gridDensity === 'compact' ? 16 : 24} color="white" />}
                </div>

                <div className="thumb-img" style={{ flex: 1, position: 'relative', background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {isDevice ? (
                    <LiveViewPoc 
                      deviceId={device.id} 
                      maxSize={currentMaxSize}
                      videoBitRate={currentVideoBitRate}
                      startDelayMs={index * 1500}
                      onMirrorTouch={(action, px, py) => handleMirrorTouch(device.id, action, px, py)}
                      onMirrorKeyCode={(keycode) => handleMirrorKeyCode(device.id, keycode)}
                      ref={el => { liveViewRefs.current[device.id] = el; }}
                    />
                  ) : (
                    <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                      <Smartphone size={gridDensity === 'compact' ? 24 : 48} opacity={0.5} style={{ margin: '0 auto 8px' }} />
                      {gridDensity !== 'compact' && <div style={{ fontWeight: 'bold', color: `var(--status-${statusColor})` }}>{device.status.toUpperCase()}</div>}
                    </div>
                  )}
                </div>

                {gridDensity !== 'compact' && (
                  <div className="thumb-footer" style={{ padding: gridDensity === 'normal' ? '8px' : '12px' }}>
                    {gridDensity === 'large' && (
                      <div className="thumb-name" style={{ fontSize: '14px', marginBottom: '8px' }}>
                        {device.customName || device.name || device.model || 'Unknown'} ({device.id})
                      </div>
                    )}
                    
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div className="thumb-status" style={{ fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <div className={`status-dot ${statusColor}`} />
                        {gridDensity === 'normal' ? (device.customName || device.id) : device.status}
                      </div>
                      
                      <div className={`thumb-actions ${gridDensity === 'normal' ? 'hover-only' : ''}`} style={{ display: 'flex', gap: '4px' }}>
                        {isDevice && (
                          <>
                            <button className="icon-btn" style={{ padding: '4px' }} onClick={() => window.electronAPI.toggleScreen(device.id)} title="Toggle Screen Power">
                              <Power size={14} />
                            </button>
                            <button className="icon-btn" style={{ padding: '4px' }} onClick={() => handleSwitchToWireless(device.id)} title="Switch to Wireless ADB" disabled={actionInProgress}>
                              <Wifi size={14} />
                            </button>
                            <button className="icon-btn" style={{ padding: '4px' }} onClick={() => { setFocusedDeviceId(device.id); setShowAdbConsole(true); }} title="ADB Console">
                              <Terminal size={14} />
                            </button>
                          </>
                        )}
                        <button className="icon-btn" style={{ padding: '4px' }} onClick={() => setHistoryDevice(device)}>
                          <History size={14} />
                        </button>
                        <button className="icon-btn" style={{ padding: '4px' }} onClick={(e) => openSettings(device, e)}>
                          <Settings size={14} />
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {discoveredDevices.filter(dd => !devices.some(d => d.id === dd.ip || d.lastKnownIp === dd.ip.split(':')[0] || (dd.serial && (d.serial === dd.serial || d.id === dd.serial)))).map((dd, index) => {
            const currentSize = {
              compact: { w: 200, h: 380 },
              normal: { w: 280, h: 520 },
              large: { w: 380, h: 700 }
            }[gridDensity];

            return (
              <div 
                key={dd.ip} 
                className={`thumb-card`} 
                style={{ 
                  width: `${Math.floor(currentSize.w * zoomLevel)}px`,
                  height: `${Math.floor(currentSize.h * zoomLevel)}px`,
                  display: 'flex', 
                  flexDirection: 'column',
                  background: 'var(--bg-dark)',
                  border: '2px dashed var(--accent)',
                  opacity: 0.8
                }}
              >
                <div className="thumb-img" style={{ flex: 1, position: 'relative', background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                    <Wifi size={gridDensity === 'compact' ? 24 : 48} opacity={0.5} style={{ margin: '0 auto 8px' }} color="var(--accent)" />
                    {gridDensity !== 'compact' && <div style={{ fontWeight: 'bold', color: `var(--accent)` }}>DISCOVERED</div>}
                  </div>
                </div>

                {gridDensity !== 'compact' && (
                  <div className="thumb-footer" style={{ padding: gridDensity === 'normal' ? '8px' : '12px' }}>
                    {gridDensity === 'large' && (
                      <div className="thumb-name" style={{ fontSize: '14px', marginBottom: '8px' }}>
                        {dd.name || 'Unknown'} ({dd.ip})
                      </div>
                    )}
                    
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div className="thumb-status" style={{ fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <div className={`status-dot`} style={{ background: 'var(--accent)' }} />
                        {gridDensity === 'normal' ? (dd.name || dd.ip) : 'New Network Device'}
                      </div>
                      
                      <div className={`thumb-actions ${gridDensity === 'normal' ? 'hover-only' : ''}`} style={{ display: 'flex', gap: '4px' }}>
                        <button className="icon-btn" style={{ padding: '4px', background: 'var(--accent)', color: 'black' }} onClick={async () => {
                          const res = await window.electronAPI.connectIp(dd.ip);
                          if (!res.success) setGlobalMessage(`Failed to connect to ${dd.ip}: ${res.error}`);
                        }} title="Connect to device">
                          Connect
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {results && (
          <div className="results-overlay">
            <div className="results-header">
              <h3>Action Results</h3>
              <button className="icon-btn" onClick={() => setResults(null)}><XCircle size={20} /></button>
            </div>
            <div className="results-body">
              {results.map((r, i) => (
                <div key={i} className={`result-item ${r.success ? 'success' : 'failure'}`}>
                  <div className="result-item-title">
                    {devices.find(d => d.id === r.deviceId)?.customName || r.deviceId}
                    <span style={{marginLeft: '8px', fontSize: '10px', color: 'var(--text-muted)'}}>[{r.action}]</span>
                  </div>
                  {r.success ? (
                    <span style={{fontSize: '12px', color: 'var(--status-green)'}}>Success</span>
                  ) : (
                    <span className="result-item-error">Failed: {r.error}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      {showAdbConsole && focusedDeviceId && (
        <div className="modal-overlay" onClick={() => setShowAdbConsole(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{ width: '600px', maxWidth: '90vw' }}>
            <h3>ADB Console: {focusedDeviceId}</h3>
            <div style={{ padding: '16px', background: 'var(--bg-color)', display: 'flex', flexDirection: 'column', gap: '8px', borderRadius: '8px' }}>
              <div style={{display: 'flex', gap: '8px'}}>
                <span style={{fontFamily: 'monospace', color: 'var(--accent)', alignSelf: 'center'}}>$</span>
                <input 
                  type="text" 
                  value={adbCommand}
                  onChange={e => setAdbCommand(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && runAdbCommand()}
                  placeholder="adb shell command..."
                  style={{flex: 1, padding: '8px', background: 'var(--card-bg)', color: 'var(--text-main)', border: '1px solid var(--border)', borderRadius: '4px', fontFamily: 'monospace'}}
                />
                <button className="large-btn primary" style={{padding: '8px 16px', fontSize: '14px'}} onClick={runAdbCommand}>Run</button>
              </div>
              {adbOutput && (
                <pre style={{margin: 0, padding: '8px', background: '#000', color: '#0f0', borderRadius: '4px', fontSize: '12px', maxHeight: '200px', overflowY: 'auto'}}>
                  {adbOutput}
                </pre>
              )}
            </div>
            <div className="modal-actions" style={{ marginTop: '16px' }}>
              <button className="primary-btn" onClick={() => setShowAdbConsole(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {settingsDevice && (
        <div className="modal-overlay" onClick={() => setSettingsDevice(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <h3>Device Settings: {settingsDevice.id}</h3>
            
            <div className="form-group">
              <label>Custom Name</label>
              <input 
                value={settingsForm.customName}
                onChange={e => setSettingsForm({...settingsForm, customName: e.target.value})}
                placeholder="e.g. Test Phone 1"
              />
            </div>
            
            <div className="form-group">
              <label>Tags (comma separated)</label>
              <input 
                value={settingsForm.tags}
                onChange={e => setSettingsForm({...settingsForm, tags: e.target.value})}
                placeholder="e.g. Broken Screen, Battery Test"
              />
            </div>

            <div className="form-group" style={{ flexDirection: 'row', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
              <input 
                type="checkbox" 
                id="isBareBoard"
                checked={settingsForm.isBareBoard}
                onChange={e => setSettingsForm({...settingsForm, isBareBoard: e.target.checked})}
                style={{ width: 'auto' }}
              />
              <label htmlFor="isBareBoard" style={{ cursor: 'pointer', margin: 0 }}>Mark as Bare Board (No Screen)</label>
            </div>

            <div className="form-group">
              <label>Notes</label>
              <textarea 
                rows={3}
                value={settingsForm.notes}
                onChange={e => setSettingsForm({...settingsForm, notes: e.target.value})}
                placeholder="Internal repair notes..."
              />
            </div>

            {settingsDevice.history && settingsDevice.history.length > 0 && (
              <div className="form-group">
                <label>Recent History</label>
                <div style={{ maxHeight: '80px', overflowY: 'auto', background: 'var(--bg-color)', padding: '8px', borderRadius: '8px', fontSize: '12px' }}>
                  {settingsDevice.history.slice(0,5).map((h, i) => (
                    <div key={i} style={{ marginBottom: '4px', display: 'flex', gap: '8px' }}>
                      <span style={{ color: 'var(--text-muted)' }}>{new Date(h.timestamp).toLocaleTimeString()}</span>
                      <span>{h.action}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            
            <div className="form-group" style={{borderTop: '1px solid var(--border)', paddingTop: '16px'}}>
              <label>Single-Target Send to this Device</label>
              <div style={{display: 'flex', gap: '8px'}}>
                <input 
                  type="text"
                  placeholder="Text to send..."
                  id="settingsDeviceSendText"
                  style={{flex: 1}}
                />
                <button className="large-btn primary" style={{padding: '8px', fontSize: '14px'}} onClick={() => {
                  const val = (document.getElementById('settingsDeviceSendText') as HTMLInputElement).value;
                  executeSingleTarget(settingsDevice.id, val);
                }}>Send Only Here</button>
              </div>
            </div>

            <div className="modal-actions" style={{borderTop: '1px solid var(--border)', paddingTop: '16px'}}>
              <button onClick={() => setSettingsDevice(null)}>Cancel</button>
              <button className="primary-btn" onClick={saveSettings}>Save Settings</button>
            </div>
          </div>
        </div>
      )}

      {showAccountsModal && (
        <div className="modal-overlay" onClick={() => setShowAccountsModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <h3>Manage Test Accounts</h3>
            <p style={{fontSize: '12px', color: 'var(--text-muted)', margin: 0}}>
              Stored locally on this computer. Used for quick bulk-injection of usernames.
            </p>
            
            <div style={{maxHeight: '200px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px', margin: '12px 0'}}>
              {testAccounts.length === 0 && <div style={{fontSize: '14px', color: 'var(--text-muted)'}}>No accounts saved.</div>}
              {testAccounts.map(account => (
                <div key={account.id} style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-color)', padding: '8px', borderRadius: '4px'}}>
                  <div style={{display: 'flex', flexDirection: 'column'}}>
                    <span style={{fontWeight: 600, fontSize: '14px'}}>{account.label || 'Account'}</span>
                    <span style={{fontSize: '12px', color: 'var(--text-muted)'}}>{account.username}</span>
                  </div>
                  <button className="icon-btn" onClick={() => {
                    const newAccounts = testAccounts.filter(a => a.id !== account.id);
                    setTestAccounts(newAccounts);
                    localStorage.setItem('testAccounts', JSON.stringify(newAccounts));
                  }}>
                    <XCircle size={16} color="var(--danger)" />
                  </button>
                </div>
              ))}
            </div>

            <div className="form-group" style={{borderTop: '1px solid var(--border)', paddingTop: '16px'}}>
              <label>Add New Account</label>
              <input 
                value={newAccountInput}
                onChange={e => setNewAccountInput(e.target.value)}
                placeholder="Username or email..."
                onKeyDown={e => {
                  if (e.key === 'Enter' && newAccountInput.trim()) {
                    const newAccounts = [...testAccounts, { id: Date.now().toString(), label: newAccountInput.split('@')[0], username: newAccountInput.trim() }];
                    setTestAccounts(newAccounts);
                    localStorage.setItem('testAccounts', JSON.stringify(newAccounts));
                    setNewAccountInput('');
                  }
                }}
              />
              <button className="large-btn primary" style={{padding: '8px', marginTop: '8px', justifyContent: 'center'}} onClick={() => {
                if(newAccountInput.trim()) {
                  const newAccounts = [...testAccounts, { id: Date.now().toString(), label: newAccountInput.split('@')[0], username: newAccountInput.trim() }];
                  setTestAccounts(newAccounts);
                  localStorage.setItem('testAccounts', JSON.stringify(newAccounts));
                  setNewAccountInput('');
                }
              }}>Add Account</button>
            </div>

            <div className="modal-actions">
              <button onClick={() => setShowAccountsModal(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {showDistributionModal && (
        <div className="modal-overlay" onClick={() => setShowDistributionModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{maxWidth: '600px'}}>
            <h3>Review Distribution Mapping</h3>
            <p style={{fontSize: '12px', color: 'var(--text-muted)'}}>Review which text line will be sent to which device. You can swap assignments if needed.</p>
            
            <div style={{maxHeight: '300px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px', margin: '12px 0'}}>
              {distributionMapping.map((item, idx) => {
                const device = devices.find(d => d.id === item.deviceId);
                return (
                  <div key={idx} style={{display: 'flex', gap: '12px', alignItems: 'center', background: 'var(--bg-color)', padding: '8px', borderRadius: '4px'}}>
                    <div style={{width: '150px', fontSize: '14px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
                      {device?.customName || device?.name || device?.model}
                    </div>
                    <div style={{flex: 1}}>
                      <input 
                        type="text" 
                        value={item.textLine}
                        onChange={(e) => {
                          const newMapping = [...distributionMapping];
                          newMapping[idx].textLine = e.target.value;
                          setDistributionMapping(newMapping);
                        }}
                        style={{width: '100%', padding: '6px', border: '1px solid var(--border)', borderRadius: '4px', background: 'var(--card-bg)', color: 'var(--text-main)'}}
                      />
                    </div>
                    <div style={{display: 'flex', flexDirection: 'column', gap: '2px'}}>
                      <button disabled={idx === 0} onClick={() => {
                        const newM = [...distributionMapping];
                        [newM[idx-1], newM[idx]] = [newM[idx], newM[idx-1]];
                        setDistributionMapping(newM);
                      }} style={{background: 'transparent', border: 'none', color: 'var(--text-main)', cursor: 'pointer', padding: '0 4px'}}>↑</button>
                      <button disabled={idx === distributionMapping.length - 1} onClick={() => {
                        const newM = [...distributionMapping];
                        [newM[idx+1], newM[idx]] = [newM[idx], newM[idx+1]];
                        setDistributionMapping(newM);
                      }} style={{background: 'transparent', border: 'none', color: 'var(--text-main)', cursor: 'pointer', padding: '0 4px'}}>↓</button>
                    </div>
                  </div>
                )
              })}
            </div>
            
            <div className="modal-actions" style={{borderTop: '1px solid var(--border)', paddingTop: '16px'}}>
              <button onClick={() => setShowDistributionModal(false)}>Cancel</button>
              <button className="primary-btn" onClick={executeDistribution}>Execute Distribution</button>
            </div>
          </div>
        </div>
      )}

      {historyDevice && (
        <div className="modal-overlay" onClick={() => setHistoryDevice(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{ width: '500px', maxWidth: '90vw' }}>
            <h3>Action History: {historyDevice.customName || historyDevice.name || historyDevice.id}</h3>
            <div style={{ maxHeight: '400px', overflowY: 'auto', background: 'var(--bg-color)', padding: '12px', borderRadius: '8px' }}>
              {historyDevice.history && historyDevice.history.length > 0 ? (
                historyDevice.history.map((h, i) => (
                  <div key={i} style={{ marginBottom: '8px', paddingBottom: '8px', borderBottom: '1px solid var(--border)', display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '12px', whiteSpace: 'nowrap' }}>
                      {new Date(h.timestamp).toLocaleString()}
                    </span>
                    <span style={{ fontSize: '14px', color: 'var(--text-main)', wordBreak: 'break-word' }}>
                      {h.action}
                    </span>
                  </div>
                ))
              ) : (
                <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '20px' }}>
                  No action history available for this device.
                </div>
              )}
            </div>
            <div className="modal-actions" style={{ marginTop: '16px' }}>
              <button className="primary-btn" onClick={() => setHistoryDevice(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {globalMessage && (
        <div style={{position: 'fixed', top: 20, right: 20, background: 'var(--card-bg)', border: '1px solid var(--border)', padding: '16px', borderRadius: '8px', zIndex: 9999, color: 'var(--text-main)', display: 'flex', flexDirection: 'column', gap: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.5)'}}>
          <div>{globalMessage}</div>
          <button className="primary-btn" onClick={() => setGlobalMessage('')}>OK</button>
        </div>
      )}

      {confirmDialog && (
        <div style={{position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000}}>
          <div style={{background: 'var(--bg-color)', padding: '24px', borderRadius: '8px', border: '1px solid var(--border)', maxWidth: '400px'}}>
            <h3 style={{marginTop: 0}}>Confirm Action</h3>
            <p>{confirmDialog.msg}</p>
            <div style={{display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '16px'}}>
              <button className="secondary-btn" onClick={() => setConfirmDialog(null)}>Cancel</button>
              <button className="primary-btn" onClick={() => { confirmDialog.onConfirm(); setConfirmDialog(null); }}>Confirm</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
