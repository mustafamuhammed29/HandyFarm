$ErrorActionPreference = "Stop"

$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $SCRIPT_DIR

$JAVA_DIR = "C:\Program Files\Android\Android Studio\jbr\bin"
$JAVAC = Join-Path $JAVA_DIR "javac.exe"
$JAR = Join-Path $JAVA_DIR "jar.exe"
$KEYTOOL = Join-Path $JAVA_DIR "keytool.exe"

$SDK_DIR = "C:\Users\musta\AppData\Local\Android\Sdk"
$BUILD_TOOLS_DIR = Join-Path $SDK_DIR "build-tools\36.1.0"
$AAPT2 = Join-Path $BUILD_TOOLS_DIR "aapt2.exe"
$D8 = Join-Path $BUILD_TOOLS_DIR "d8.bat"
$ZIPALIGN = Join-Path $BUILD_TOOLS_DIR "zipalign.exe"
$APKSIGNER = Join-Path $BUILD_TOOLS_DIR "apksigner.bat"
$ANDROID_JAR = Join-Path $SDK_DIR "platforms\android-36\android.jar"

$BUILD_DIR = Join-Path $SCRIPT_DIR "build"
$GEN_DIR = Join-Path $BUILD_DIR "gen"
$CLASSES_DIR = Join-Path $BUILD_DIR "classes"

if (Test-Path $BUILD_DIR) {
    Remove-Item -Recurse -Force $BUILD_DIR
}
New-Item -ItemType Directory -Force -Path $BUILD_DIR | Out-Null
New-Item -ItemType Directory -Force -Path $GEN_DIR | Out-Null
New-Item -ItemType Directory -Force -Path $CLASSES_DIR | Out-Null

Write-Host "==> 1. Linking resources with aapt2 link..."
$UNALIGNED_APK = Join-Path $BUILD_DIR "adversary-unaligned.apk"
$MANIFEST = Join-Path $SCRIPT_DIR "AndroidManifest.xml"
& $AAPT2 link -I $ANDROID_JAR --manifest $MANIFEST --java $GEN_DIR -o $UNALIGNED_APK --min-sdk-version 24 --target-sdk-version 34 --version-code 1 --version-name "1.0"
if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed" }

Write-Host "==> 2. Compiling Java sources with javac..."
$JAVA_SOURCES = (Get-ChildItem -Recurse -Path "$SCRIPT_DIR\src" -Filter "*.java").FullName
& $JAVAC -encoding UTF-8 -cp $ANDROID_JAR -d $CLASSES_DIR $JAVA_SOURCES
if ($LASTEXITCODE -ne 0) { throw "javac failed" }

Write-Host "==> 3. Converting bytecode to DEX with d8..."
$CLASS_FILES = (Get-ChildItem -Recurse -Path $CLASSES_DIR -Filter "*.class").FullName
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
$env:PATH = "$JAVA_DIR;$env:PATH"
& cmd.exe /c "`"$D8`" --lib `"$ANDROID_JAR`" --output `"$BUILD_DIR`" --min-api 24 $($CLASS_FILES -join ' ')"
if ($LASTEXITCODE -ne 0) { throw "d8 failed" }

Write-Host "==> 4. Packaging classes.dex into APK..."
Push-Location $BUILD_DIR
try {
    & $JAR uf $UNALIGNED_APK classes.dex
    if ($LASTEXITCODE -ne 0) { throw "jar uf failed" }
} finally {
    Pop-Location
}

Write-Host "==> 5. Aligning APK with zipalign..."
$ALIGNED_APK = Join-Path $BUILD_DIR "adversary-aligned.apk"
& $ZIPALIGN -p -f 4 $UNALIGNED_APK $ALIGNED_APK
if ($LASTEXITCODE -ne 0) { throw "zipalign failed" }

Write-Host "==> 6. Signing APK with apksigner (distinct throwaway key)..."
$KEYSTORE = Join-Path $BUILD_DIR "attacker.keystore"
& $KEYTOOL -genkeypair -v -keystore $KEYSTORE -alias attacker -keyalg RSA -keysize 2048 -validity 100 -storepass "attacker123" -keypass "attacker123" -dname "CN=AttackerApp, O=EvilCorp, C=US"

$SIGNED_APK = Join-Path $BUILD_DIR "adversary.apk"
& cmd.exe /c "`"$APKSIGNER`" sign --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true --ks `"$KEYSTORE`" --ks-pass pass:attacker123 --ks-key-alias attacker --key-pass pass:attacker123 --out `"$SIGNED_APK`" `"$ALIGNED_APK`""
if ($LASTEXITCODE -ne 0) { throw "apksigner sign failed" }

Write-Host "==> Built adversary.apk: $SIGNED_APK"
