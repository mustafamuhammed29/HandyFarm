const fs = require('fs');
let code = fs.readFileSync('c:/Users/musta/Desktop/HandyFarm/src/App.tsx', 'utf8');

const find = `  const executeBulkAction = async (action: string, payload?: any, e?: React.MouseEvent) => {
    let targetIds = Array.from(selectedIds);
    console.log(\`[executeBulkAction] triggered action: \${action}, payload: \${payload}, targetIds: \${targetIds.length}, selectedIds: \${selectedIds.size}\`);
    
    // Alt+Click logic: run only on focused device if it exists
    if (e && e.altKey && focusedDeviceId) {
      targetIds = [focusedDeviceId];
      console.log(\`[executeBulkAction] Alt+Click overrides targetIds to focusedDevice: \${focusedDeviceId}\`);
    } else if (targetIds.length === 0) {
      console.warn(\`[executeBulkAction] Aborting: targetIds is empty (no devices selected).\`);
      return;
    }`;
const replace = `  const executeBulkAction = async (action: string, payload?: any, e?: React.MouseEvent) => {
    let targetIds = Array.from(selectedIds);
    
    // Fallback to focused device if no checkboxes are selected
    if (targetIds.length === 0 && focusedDeviceId) {
      targetIds = [focusedDeviceId];
      console.log(\`[executeBulkAction] No checkboxes ticked, falling back to focused device: \${focusedDeviceId}\`);
    } else if (e && e.altKey && focusedDeviceId) {
      targetIds = [focusedDeviceId];
      console.log(\`[executeBulkAction] Alt+Click overrides targetIds to focusedDevice: \${focusedDeviceId}\`);
    }

    console.log(\`[executeBulkAction] executing \${action} with payload \${payload} on \${targetIds.length} devices: \${targetIds.join(', ')}\`);

    if (targetIds.length === 0) {
      console.warn(\`[executeBulkAction] Aborting: No devices selected and no focused device.\`);
      return;
    }`;

code = code.replace(find, replace);
fs.writeFileSync('c:/Users/musta/Desktop/HandyFarm/src/App.tsx', code, 'utf8');
console.log('App.tsx executeBulkAction updated');
