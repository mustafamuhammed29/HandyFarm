import { useEffect, useState } from 'react';
import { 
  Smartphone, XCircle, Play, CheckSquare, Square, RefreshCw, Link as LinkIcon, Download, RotateCcw, 
  Moon, Sun, Pin, PinOff, Settings, Search, LayoutGrid, Monitor, 
  Tag, Terminal, Camera, Power, FileUp, FileDown, Save, Key, History
} from 'lucide-react';
import './App.css';
import type { DeviceData, QuickPhrase, TestAccount } from './types';

function App() {
  const [devices, setDevices] = useState<DeviceData[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [actionInProgress, setActionInProgress] = useState(false);
  const [results, setResults] = useState<{deviceId: string, success: boolean, error?: string, action: string}[] | null>(null);
  
  const [focusedDeviceId, setFocusedDeviceId] = useState<string | null>(null);
  const [isRotated, setIsRotated] = useState(false);
  const [sidebarPinned, setSidebarPinned] = useState(true);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [searchQuery, setSearchQuery] = useState('');
  
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
            alert(`Migration failed for account ${acc.id}: ${res.error}`);
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
    let filtered = devices;
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

  const visibleDevices = getFilteredDevices();

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

  const handleDeviceClick = (id: string) => {
    setFocusedDeviceId(id);
    setIsRotated(false);
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
      if (!window.confirm(`Reboot ${targetIds.length} device(s)?`)) return;
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
    if (res.success) alert(`Exported to ${res.path}`);
  };

  const handleImport = async () => {
    const res = await window.electronAPI.importConfig();
    if (res.success) alert(`Import successful!`);
  };

  const runAdbCommand = async () => {
    if (!focusedDeviceId || !adbCommand) return;
    setAdbOutput('Running...');
    const res = await window.electronAPI.runAdbCommand(focusedDeviceId, adbCommand);
    setAdbOutput(res.output || res.error || 'Done.');
  };

  const focusedDevice = devices.find(d => d.id === focusedDeviceId);

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
            <button className="large-btn" onClick={toggleSelectAll}>
              {selectedIds.size === visibleDevices.length && visibleDevices.length > 0 ? <CheckSquare size={20} className="text-accent" /> : <Square size={20} />}
              {selectedIds.size === visibleDevices.length && visibleDevices.length > 0 ? 'Deselect All' : 'Select All'}
            </button>
            
            <div style={{display: 'flex', gap: '8px'}}>
              <button className="large-btn" style={{flex: 1, padding: '8px', fontSize: '14px', justifyContent: 'center'}} onClick={handleImport} title="Import Config"><FileDown size={16}/> Import</button>
              <button className="large-btn" style={{flex: 1, padding: '8px', fontSize: '14px', justifyContent: 'center'}} onClick={handleExport} title="Export Config"><FileUp size={16}/> Export</button>
            </div>
          </div>

          <div className="action-section">
            <h3>Batch App & Files</h3>
            <button className="large-btn" disabled={actionInProgress} onClick={(e) => executeBulkAction('installApk', window.prompt('APK Path:'), e)}>
              <Download size={20} /> Install APK
            </button>
            <button className="large-btn" disabled={actionInProgress} onClick={(e) => executeBulkAction('openLink', window.prompt('URL:'), e)}>
              <LinkIcon size={20} /> Open Link
            </button>
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
                      alert("Please select target devices first.");
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
        <div className="focused-view">
          {focusedDevice ? (
            <div className="focused-card">
              <div className="focused-header">
                <div className="focused-title-area">
                  <h2 className="focused-title">
                    {focusedDevice.customName || focusedDevice.name || focusedDevice.model || 'Unknown Device'}
                    {focusedDevice.isBareBoard && <span className="board-badge">Bare Board</span>}
                  </h2>
                  <div style={{ fontSize: '14px', color: 'var(--text-muted)' }}>
                    ({focusedDevice.serial || focusedDevice.id})
                  </div>
                </div>
                <div className="focused-actions">
                  <button className="icon-btn" onClick={() => window.electronAPI.takeScreenshot(focusedDevice.id)} title="Save Screenshot">
                    <Camera size={20} />
                  </button>
                  <button className="icon-btn" onClick={() => window.electronAPI.toggleScreen(focusedDevice.id)} title="Toggle Screen Power">
                    <Power size={20} />
                  </button>
                  <button className="icon-btn" onClick={() => setIsRotated(!isRotated)} title="Rotate Screen">
                    <RotateCcw size={20} />
                  </button>
                  <button className="large-btn primary" style={{ padding: '8px 16px', fontSize: '14px' }} disabled={focusedDevice.status !== 'device'} onClick={() => window.electronAPI.launchScrcpy(focusedDevice.id, {maxFps: 60})}>
                    <Play size={18} /> Full Control
                  </button>
                  <button className="icon-btn" onClick={() => setShowAdbConsole(!showAdbConsole)} title="ADB Console">
                    <Terminal size={20} />
                  </button>
                </div>
              </div>
              <div className="focused-body">
                {focusedDevice.thumbnail && !focusedDevice.isBareBoard ? (
                  <img 
                    src={focusedDevice.thumbnail} 
                    alt="Screen" 
                    className={`focused-image ${isRotated ? 'rotated' : ''}`} 
                  />
                ) : (
                  <div className="no-focus-state">
                    <Monitor size={64} opacity={0.2} />
                    <span>No screen feed available</span>
                  </div>
                )}
              </div>
              {showAdbConsole && (
                <div style={{borderTop: '1px solid var(--border)', padding: '16px', background: 'var(--bg-color)', display: 'flex', flexDirection: 'column', gap: '8px'}}>
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
                    <pre style={{margin: 0, padding: '8px', background: '#000', color: '#0f0', borderRadius: '4px', fontSize: '12px', maxHeight: '100px', overflowY: 'auto'}}>
                      {adbOutput}
                    </pre>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="no-focus-state">
              <LayoutGrid size={64} opacity={0.2} />
              <h2>No Device Focused</h2>
              <p>Select a device from the thumbnail strip below.</p>
            </div>
          )}
        </div>

        <div className="thumbnail-strip-container">
          <div className="strip-header">
            <h2>Connected Devices</h2>
            <div className="strip-stats">
              <span><strong style={{color: 'var(--status-green)'}}>{devices.filter(d => d.status === 'device').length}</strong> Online</span>
              <span><strong style={{color: 'var(--status-red)'}}>{devices.filter(d => d.status === 'offline').length}</strong> Offline</span>
            </div>
          </div>
          <div className="strip-scroll-area">
            {visibleDevices.map(device => {
              const isSelected = selectedIds.has(device.id);
              const isFocused = focusedDeviceId === device.id;
              
              let statusColor = 'gray';
              if (device.status === 'device') statusColor = 'green';
              else if (device.status === 'offline') statusColor = 'red';
              else if (device.status === 'unauthorized') statusColor = 'yellow';

              return (
                <div 
                  key={device.id} 
                  className={`thumb-card ${isSelected ? 'selected' : ''} ${isFocused ? 'is-focused' : ''}`}
                  onClick={() => handleDeviceClick(device.id)}
                >
                  <div className="thumb-checkbox" onClick={(e) => toggleDeviceSelect(device.id, e)}>
                    {isSelected ? <CheckSquare size={18} color="var(--accent)" /> : <Square size={18} color="white" />}
                  </div>
                  <div className="thumb-img">
                    {device.thumbnail && !device.isBareBoard ? (
                      <img src={device.thumbnail} alt="" />
                    ) : (
                      <Smartphone size={40} color="var(--text-muted)" opacity={0.5} />
                    )}
                  </div>
                  <div className="thumb-footer">
                    <div className="thumb-name">
                      {device.customName || device.name || device.model || 'Unknown'}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div className="thumb-status">
                        <div className={`status-dot ${statusColor}`} />
                        {device.status}
                      </div>
                      <div style={{display: 'flex', gap: '4px'}}>
                        {device.tags && device.tags.length > 0 && <Tag size={12} color="var(--accent)" />}
                        <button className="icon-btn" style={{ padding: '2px' }} onClick={(e) => { e.stopPropagation(); setHistoryDevice(device); }}>
                          <History size={14} />
                        </button>
                        <button className="icon-btn" style={{ padding: '2px' }} onClick={(e) => openSettings(device, e)}>
                          <Settings size={14} />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
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
    </div>
  );
}

export default App;
