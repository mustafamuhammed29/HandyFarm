const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

app.whenReady().then(() => {
  const secureAccountsPath = path.join(app.getPath('userData'), 'secure-accounts.json');
  console.log('Secure Accounts Path:', secureAccountsPath);
  
  if (safeStorage.isEncryptionAvailable()) {
    const data = {
      'test-id-123': safeStorage.encryptString('superSecretPassword123').toString('base64')
    };
    fs.writeFileSync(secureAccountsPath, JSON.stringify(data));
    console.log('Wrote encrypted password.');
  } else {
    console.log('Encryption not available.');
  }
  
  console.log(fs.readFileSync(secureAccountsPath, 'utf8'));
  app.quit();
});
