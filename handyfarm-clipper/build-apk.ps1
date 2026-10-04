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

Write-Host "==> Checking build prerequisites..."
foreach ($tool in @($JAVAC, $JAR, $KEYTOOL, $AAPT2, $D8, $ZIPALIGN, $APKSIGNER, $ANDROID_JAR)) {
    if (-not (Test-Path $tool)) {
        throw "Required tool/file not found: $tool"
    }
}

$BUILD_DIR = Join-Path $SCRIPT_DIR "build"
$KEYSTORE_DIR = Join-Path $SCRIPT_DIR "keystore"
$GEN_DIR = Join-Path $BUILD_DIR "gen"
$CLASSES_DIR = Join-Path $BUILD_DIR "classes"

if (Test-Path $BUILD_DIR) {
    Remove-Item -Recurse -Force $BUILD_DIR
}
New-Item -ItemType Directory -Force -Path $BUILD_DIR | Out-Null
New-Item -ItemType Directory -Force -Path $GEN_DIR | Out-Null
New-Item -ItemType Directory -Force -Path $CLASSES_DIR | Out-Null
New-Item -ItemType Directory -Force -Path $KEYSTORE_DIR | Out-Null

Write-Host "==> 1. Compiling resources with aapt2 compile..."
$RES_ZIP = Join-Path $BUILD_DIR "res.zip"
& $AAPT2 compile --dir app/src/main/res -o $RES_ZIP
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile failed" }

Write-Host "==> 2. Linking resources with aapt2 link..."
$UNALIGNED_APK = Join-Path $BUILD_DIR "app-unaligned.apk"
$MANIFEST = "app/src/main/AndroidManifest.xml"
& $AAPT2 link -I $ANDROID_JAR --manifest $MANIFEST --java $GEN_DIR -o $UNALIGNED_APK $RES_ZIP --min-sdk-version 24 --target-sdk-version 34 --version-code 1 --version-name "1.0"
if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed" }

Write-Host "==> 3. Compiling Java sources with javac..."
$JAVA_SOURCES = (Get-ChildItem -Recurse -Path "app/src/main/java" -Filter "*.java").FullName
$GEN_SOURCES = (Get-ChildItem -Recurse -Path $GEN_DIR -Filter "*.java" -ErrorAction SilentlyContinue).FullName
$ALL_SOURCES = @($JAVA_SOURCES) + @($GEN_SOURCES)

& $JAVAC -encoding UTF-8 -cp $ANDROID_JAR -d $CLASSES_DIR $ALL_SOURCES
if ($LASTEXITCODE -ne 0) { throw "javac failed" }

Write-Host "==> 4. Converting bytecode to DEX with d8..."
$CLASS_FILES = (Get-ChildItem -Recurse -Path $CLASSES_DIR -Filter "*.class").FullName
# d8.bat needs JAVA_HOME or java in path
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
$env:PATH = "$JAVA_DIR;$env:PATH"
& cmd.exe /c "`"$D8`" --lib `"$ANDROID_JAR`" --output `"$BUILD_DIR`" --min-api 24 $($CLASS_FILES -join ' ')"
if ($LASTEXITCODE -ne 0) { throw "d8 failed" }

Write-Host "==> 5. Packaging classes.dex and native libraries into APK..."
# ==============================================================================================
# ARCHITECTURAL NOTE & TECHNICAL DEBT: libwg-go.so NATIVE BINARIES & IN-PLACE BYTE PATCH
# ==============================================================================================
# 1. Background & Context:
#    The companion app embeds the official WireGuard Go userspace engine (libwg-go.so) via JNI
#    (com.wireguard.android.backend.GoBackend). In the official upstream wireguard-android build,
#    the unix domain socket path for WireGuard's UAPI listener is hardcoded in ipc/uapi_android.go:
#        socketPath := "/data/data/com.wireguard.android/cache/wireguard/" + name + ".sock"
#
#    Under Android's Linux sandbox and SELinux policies, an unprivileged app process cannot
#    create or write to another application's private data directory (/data/data/com.wireguard.android).
#    Running unpatched results in: "UAPIOpen: mkdir /data/data/com.wireguard.android: permission denied".
#
# 2. In-Place Byte-Patch Details:
#    Because "com.wireguard.android" (21 ASCII chars) and "com.handyfarm.clipper" (21 ASCII chars)
#    happen to have the EXACT same string length, we performed an in-place raw byte replacement:
#        Original: b"/data/data/com.wireguard.android/cache/wireguard" (46 bytes)
#        Patched:  b"/data/data/com.handyfarm.clipper/cache/wireguard" (46 bytes)
#
#    Exact byte offsets of the patched string in app/src/main/jniLibs/:
#        - arm64-v8a/libwg-go.so:   offset 0x000982e0 (623,328 decimal)
#        - armeabi-v7a/libwg-go.so: offset 0x00059c68 (367,720 decimal)
#        - x86/libwg-go.so:         offset 0x0005a6a0 (370,336 decimal)
#        - x86_64/libwg-go.so:      offset 0x00097ce0 (621,792 decimal)
#
# 3. Known Fragility & Risks:
#    - Vendor binary layout dependency: Upstream wireguard-android updates might shift symbols,
#      restructure internal UAPI paths, or alter string encoding.
#    - Package rename fragility: If com.handyfarm.clipper is ever renamed, an in-place patch
#      will fail unless the new package name is exactly 21 characters long.
#
# 4. Long-Term Fallback Plan (Building wireguard-go from source):
#    To eliminate this binary patch technical debt permanently:
#    a. Check out the official wireguard-android source:
#       git clone https://git.zx2c4.com/wireguard-android
#    b. Locate the Go backend module in tunnel/tools/libwg-go/.
#    c. Either:
#       - Parametrize the UAPI socket path in ipc/uapi_android.go to take an exported C string
#         passed from Java at runtime (e.g., context.getCacheDir().getAbsolutePath()).
#       - OR bake in "-X main.PackageName=com.handyfarm.clipper" via Go ldflags during build.
#    d. Compile natively for all target ABIs using Android NDK toolchain:
#       NDK_TOOLCHAIN/bin/go build -buildmode=c-shared -o libwg-go.so
#    e. Replace the prebuilt binaries in app/src/main/jniLibs/ with the cleanly compiled ones.
# ==============================================================================================

$JNILIBS_DIR = Join-Path $SCRIPT_DIR "app\src\main\jniLibs"
if (Test-Path $JNILIBS_DIR) {
    $BUILD_LIB = Join-Path $BUILD_DIR "lib"
    if (Test-Path $BUILD_LIB) { Remove-Item -Recurse -Force $BUILD_LIB }
    Copy-Item -Recurse -Force $JNILIBS_DIR $BUILD_LIB
}

Push-Location $BUILD_DIR
try {
    & $JAR uf $UNALIGNED_APK classes.dex
    if ($LASTEXITCODE -ne 0) { throw "jar uf classes.dex failed" }
    if (Test-Path "lib") {
        & $JAR uf $UNALIGNED_APK lib
        if ($LASTEXITCODE -ne 0) { throw "jar uf lib failed" }
    }
} finally {
    Pop-Location
}

Write-Host "==> 6. Aligning APK with zipalign..."
$ALIGNED_APK = Join-Path $BUILD_DIR "app-aligned.apk"
& $ZIPALIGN -p -f 4 $UNALIGNED_APK $ALIGNED_APK
if ($LASTEXITCODE -ne 0) { throw "zipalign failed" }

Write-Host "==> 7. Ensuring keystore exists..."
$KEYSTORE = Join-Path $KEYSTORE_DIR "handyfarm-release.keystore"
$KEYSTORE_PASS = "handyfarm2026"
$KEY_ALIAS = "handyfarm"
if (-not (Test-Path $KEYSTORE)) {
    Write-Host "    Generating release keystore..."
    & $KEYTOOL -genkeypair -v -keystore $KEYSTORE -alias $KEY_ALIAS -keyalg RSA -keysize 2048 -validity 10000 -storepass $KEYSTORE_PASS -keypass $KEYSTORE_PASS -dname "CN=HandyFarm, OU=Tools, O=HandyFarm, C=US"
    if ($LASTEXITCODE -ne 0) { throw "keytool failed" }
}

Write-Host "==> 8. Signing APK with apksigner..."
$SIGNED_APK = Join-Path $BUILD_DIR "handyfarm-clipper-release.apk"
& cmd.exe /c "`"$APKSIGNER`" sign --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true --ks `"$KEYSTORE`" --ks-pass pass:$KEYSTORE_PASS --ks-key-alias $KEY_ALIAS --key-pass pass:$KEYSTORE_PASS --out `"$SIGNED_APK`" `"$ALIGNED_APK`""
if ($LASTEXITCODE -ne 0) { throw "apksigner sign failed" }

Write-Host "==> 9. Verifying signed APK..."
& cmd.exe /c "`"$APKSIGNER`" verify --verbose `"$SIGNED_APK`""
if ($LASTEXITCODE -ne 0) { throw "apksigner verify failed" }

$APK_SIZE = (Get-Item $SIGNED_APK).Length
$RESOURCES_APK = Join-Path (Split-Path -Parent $SCRIPT_DIR) "resources\clipper.apk"
Copy-Item -Force $SIGNED_APK $RESOURCES_APK
Write-Host "==> SUCCESS! Release APK built, signed, and copied to $RESOURCES_APK ($APK_SIZE bytes)"
