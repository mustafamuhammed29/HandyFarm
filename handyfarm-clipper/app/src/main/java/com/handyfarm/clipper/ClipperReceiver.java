package com.handyfarm.clipper;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Process;
import android.util.Log;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import org.json.JSONObject;

public class ClipperReceiver extends BroadcastReceiver {
    private static final String TAG = "HandyFarmClipper";

    public static final String ACTION_GET = "clipper.get";
    public static final String ACTION_GET_SHORT = "get";
    public static final String ACTION_SET = "clipper.set";
    public static final String ACTION_SET_SHORT = "set";
    public static final String EXTRA_TEXT = "text";

    // L5 fix: file-based clipboard push. Main writes the text to /data/local/tmp/ on the
    // device via `adb push` (no shell, no string interpolation), then broadcasts the path.
    // This avoids the previous shell-decode-then-quote trick which was vulnerable to
    // special characters in user input. Main is responsible for cleaning up the file; the
    // companion also deletes it as a defense-in-depth.
    public static final String ACTION_SET_PATH = "handyfarm.clipboard.set.path";
    public static final String EXTRA_PATH = "path";
    public static final String CLIPBOARD_TMP_DIR = "/data/local/tmp/";

    public static final String ACTION_IDENTITY_GET = "handyfarm.identity.get";
    public static final String ACTION_FOREGROUND_GET = "handyfarm.foreground.get";
    public static final String ACTION_LOCATION_SET = "handyfarm.location.set";
    public static final String ACTION_LOCATION_GET = "handyfarm.location.get";
    public static final String ACTION_RESET_BASELINE = "handyfarm.reset.baseline";
    public static final String ACTION_VPN_CONNECT = "handyfarm.vpn.connect";
    public static final String ACTION_VPN_DISCONNECT = "handyfarm.vpn.disconnect";
    public static final String ACTION_VPN_STATUS = "handyfarm.vpn.status";
    public static final String ACTION_EGRESS_GET = "handyfarm.egress.get";

    private static final int FLAG_RECEIVER_FROM_SHELL = 0x00400000;

    private boolean isAuthorizedSender(Intent intent) {
        // 1. If sent from shell via am broadcast, Android framework enforces FLAG_RECEIVER_FROM_SHELL (0x00400000).
        // Android system server strips this flag if sent by any non-shell/non-root app.
        boolean isFromShell = (intent.getFlags() & FLAG_RECEIVER_FROM_SHELL) != 0;

        // 2. If getSentFromUid() is available (API 34+), verify it is shell (2000), root (0), or this app.
        int sentUid = -1;
        if (Build.VERSION.SDK_INT >= 34) {
            sentUid = getSentFromUid();
        }

        // If UID is provided and not -1, ensure it's trusted
        if (sentUid != -1) {
            return (sentUid == Process.SHELL_UID || sentUid == 0 || sentUid == Process.myUid());
        }

        // If UID was masked/unknown (-1), require FLAG_RECEIVER_FROM_SHELL
        return isFromShell;
    }

    private boolean hasUsageStatsPermission(Context context) {
        android.app.AppOpsManager appOps = (android.app.AppOpsManager) context.getSystemService(Context.APP_OPS_SERVICE);
        if (appOps == null) return false;
        int mode;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            mode = appOps.unsafeCheckOpNoThrow(android.app.AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.getPackageName());
        } else {
            mode = appOps.checkOpNoThrow(android.app.AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.getPackageName());
        }
        return mode == android.app.AppOpsManager.MODE_ALLOWED;
    }

    private String getForegroundApp(Context context) {
        android.app.usage.UsageStatsManager usm = (android.app.usage.UsageStatsManager) context.getSystemService(Context.USAGE_STATS_SERVICE);
        if (usm == null) return "UNKNOWN";

        long time = System.currentTimeMillis();
        android.app.usage.UsageEvents events = usm.queryEvents(time - 15000, time);
        String foregroundPackage = null;
        long latestResumedTime = 0;
        if (events != null) {
            android.app.usage.UsageEvents.Event event = new android.app.usage.UsageEvents.Event();
            while (events.hasNextEvent()) {
                events.getNextEvent(event);
                int type = event.getEventType();
                Log.d(TAG, "UsageEvent: pkg=" + event.getPackageName() + " type=" + type + " time=" + event.getTimeStamp() + " cls=" + event.getClassName());
                if (type == android.app.usage.UsageEvents.Event.ACTIVITY_RESUMED || type == 1) {
                    if (event.getTimeStamp() >= latestResumedTime) {
                        latestResumedTime = event.getTimeStamp();
                        foregroundPackage = event.getPackageName();
                    }
                }
            }
        }

        if (foregroundPackage != null) {
            return foregroundPackage;
        }

        java.util.List<android.app.usage.UsageStats> stats = usm.queryUsageStats(android.app.usage.UsageStatsManager.INTERVAL_DAILY, time - 60000, time);
        if (stats != null && !stats.isEmpty()) {
            android.app.usage.UsageStats recent = null;
            for (android.app.usage.UsageStats s : stats) {
                if (recent == null || s.getLastTimeUsed() > recent.getLastTimeUsed()) {
                    recent = s;
                }
            }
            if (recent != null && recent.getPackageName() != null) {
                return recent.getPackageName();
            }
        }

        return "UNKNOWN";
    }

    private boolean isMockLocationAllowed(Context context) {
        try {
            android.app.AppOpsManager appOps = (android.app.AppOpsManager) context.getSystemService(Context.APP_OPS_SERVICE);
            if (appOps == null) return false;
            int mode;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                mode = appOps.unsafeCheckOpNoThrow(android.app.AppOpsManager.OPSTR_MOCK_LOCATION, Process.myUid(), context.getPackageName());
            } else {
                mode = appOps.checkOpNoThrow(android.app.AppOpsManager.OPSTR_MOCK_LOCATION, Process.myUid(), context.getPackageName());
            }
            return mode == android.app.AppOpsManager.MODE_ALLOWED;
        } catch (Exception e) {
            return false;
        }
    }

    private void setMockLocation(Context context, String providerName, double lat, double lng) {
        android.location.LocationManager lm = (android.location.LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) return;

        try {
            lm.addTestProvider(
                providerName,
                false, // requiresNetwork
                false, // requiresSatellite
                false, // requiresCell
                false, // hasMonetaryCost
                true,  // supportsAltitude
                true,  // supportsSpeed
                true,  // supportsBearing
                android.location.Criteria.POWER_LOW,
                android.location.Criteria.ACCURACY_FINE
            );
        } catch (Exception ignored) {
            // Already added
        }

        try {
            lm.setTestProviderEnabled(providerName, true);
        } catch (Exception ignored) {}

        android.location.Location mockLoc = new android.location.Location(providerName);
        mockLoc.setLatitude(lat);
        mockLoc.setLongitude(lng);
        mockLoc.setAltitude(15.0);
        mockLoc.setTime(System.currentTimeMillis());
        mockLoc.setElapsedRealtimeNanos(android.os.SystemClock.elapsedRealtimeNanos());
        mockLoc.setAccuracy(1.0f);

        lm.setTestProviderLocation(providerName, mockLoc);
    }

    private double getNumberExtra(Intent intent, String key) {
        if (intent.hasExtra(key)) {
            android.os.Bundle extras = intent.getExtras();
            if (extras != null) {
                Object obj = extras.get(key);
                if (obj instanceof Number) {
                    return ((Number) obj).doubleValue();
                } else if (obj instanceof String) {
                    try {
                        return Double.parseDouble((String) obj);
                    } catch (Exception ignored) {}
                }
            }
        }
        return Double.NaN;
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;

        // Security check: validate sender UID and shell flag.
        // Prevents unauthorized third-party apps on the device from abusing the receiver.
        if (!isAuthorizedSender(intent)) {
            Log.w(TAG, "Blocked unauthorized broadcast intent=" + intent);
            setResultCode(Activity.RESULT_CANCELED);
            setResultData("ERROR: Unauthorized sender");
            return;
        }

        String action = intent.getAction();
        if (action == null) return;

        // Phase 1: Stable app-generated identity
        if (ACTION_IDENTITY_GET.equals(action)) {
            android.content.SharedPreferences prefs = context.getSharedPreferences("handyfarm_companion", Context.MODE_PRIVATE);
            String uuid = prefs.getString("device_uuid", null);
            if (uuid == null) {
                uuid = java.util.UUID.randomUUID().toString();
                prefs.edit().putString("device_uuid", uuid).apply();
                Log.i(TAG, "Generated new stable device UUID: " + uuid);
            } else {
                Log.i(TAG, "Loaded existing stable device UUID: " + uuid);
            }
            setResultCode(Activity.RESULT_OK);
            setResultData(uuid);
            return;
        }

        // Phase 2: Foreground app detection
        if (ACTION_FOREGROUND_GET.equals(action)) {
            if (!hasUsageStatsPermission(context)) {
                Log.w(TAG, "Foreground app query failed: PACKAGE_USAGE_STATS permission not granted");
                setResultCode(Activity.RESULT_OK);
                setResultData("STATUS_PERMISSION_REQUIRED: PACKAGE_USAGE_STATS");
                return;
            }

            String fg = getForegroundApp(context);
            Log.i(TAG, "Current foreground app: " + fg);
            setResultCode(Activity.RESULT_OK);
            setResultData(fg);
            return;
        }

        // Phase 3: Mock location provider
        if (ACTION_LOCATION_SET.equals(action)) {
            if (!isMockLocationAllowed(context)) {
                Log.w(TAG, "Mock location not permitted for this app");
                setResultCode(Activity.RESULT_OK);
                setResultData("STATUS_PERMISSION_REQUIRED: MOCK_LOCATION (Set mock location app in Developer Options or run: adb shell appops set com.handyfarm.clipper MOCK_LOCATION allow)");
                return;
            }

            double lat = getNumberExtra(intent, "lat");
            double lng = getNumberExtra(intent, "lng");

            if (Double.isNaN(lat) || Double.isNaN(lng)) {
                setResultCode(Activity.RESULT_CANCELED);
                setResultData("ERROR: Missing or invalid lat/lng extra (use --ef lat <lat> --ef lng <lng> or --es lat <lat> --es lng <lng>)");
                return;
            }

            try {
                setMockLocation(context, android.location.LocationManager.GPS_PROVIDER, lat, lng);
                setMockLocation(context, android.location.LocationManager.NETWORK_PROVIDER, lat, lng);

                android.content.SharedPreferences prefs = context.getSharedPreferences("handyfarm_companion", Context.MODE_PRIVATE);
                prefs.edit().putString("mock_lat", String.valueOf(lat)).putString("mock_lng", String.valueOf(lng)).apply();

                Log.i(TAG, "Mock location set: lat=" + lat + ", lng=" + lng);
                setResultCode(Activity.RESULT_OK);
                setResultData("OK: lat=" + lat + ", lng=" + lng);
            } catch (Exception e) {
                Log.e(TAG, "Failed to set mock location", e);
                setResultCode(Activity.RESULT_CANCELED);
                setResultData("ERROR: " + e.getMessage());
            }
            return;
        }

        if (ACTION_LOCATION_GET.equals(action)) {
            android.content.SharedPreferences prefs = context.getSharedPreferences("handyfarm_companion", Context.MODE_PRIVATE);
            String lat = prefs.getString("mock_lat", null);
            String lng = prefs.getString("mock_lng", null);
            boolean allowed = isMockLocationAllowed(context);
            if (lat != null && lng != null) {
                setResultCode(Activity.RESULT_OK);
                setResultData("OK: lat=" + lat + ", lng=" + lng + ", mock_allowed=" + allowed);
            } else {
                setResultCode(Activity.RESULT_OK);
                setResultData("NO_MOCK_SET: mock_allowed=" + allowed);
            }
            return;
        }

        // Phase 4: Device reset-to-baseline
        if (ACTION_RESET_BASELINE.equals(action)) {
            org.json.JSONObject result = new org.json.JSONObject();
            org.json.JSONArray standaloneSuccess = new org.json.JSONArray();
            org.json.JSONArray adbRequired = new org.json.JSONArray();
            org.json.JSONArray standaloneFailed = new org.json.JSONArray();

            // 1. Reset mock location state
            try {
                android.location.LocationManager lm = (android.location.LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
                if (lm != null) {
                    try { lm.removeTestProvider(android.location.LocationManager.GPS_PROVIDER); } catch (Exception ignored) {}
                    try { lm.removeTestProvider(android.location.LocationManager.NETWORK_PROVIDER); } catch (Exception ignored) {}
                }
                android.content.SharedPreferences prefs = context.getSharedPreferences("handyfarm_companion", Context.MODE_PRIVATE);
                prefs.edit().remove("mock_lat").remove("mock_lng").apply();
                standaloneSuccess.put("mock_location_cleared");
            } catch (Exception e) {
                standaloneFailed.put("mock_location: " + e.getMessage());
            }

            // 2. Reset clipboard state
            try {
                ClipboardManager cm = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm != null) {
                    cm.setPrimaryClip(ClipData.newPlainText("", ""));
                    standaloneSuccess.put("clipboard_cleared");
                }
            } catch (Exception e) {
                standaloneFailed.put("clipboard: " + e.getMessage());
            }

            // 3. Attempt dismissing system dialogs
            try {
                Intent closeDialogs = new Intent(Intent.ACTION_CLOSE_SYSTEM_DIALOGS);
                context.sendBroadcast(closeDialogs);
                standaloneSuccess.put("close_system_dialogs");
            } catch (SecurityException se) {
                adbRequired.put("close_system_dialogs (requires BROADCAST_CLOSE_SYSTEM_DIALOGS permission or ADB shell 'am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS')");
            } catch (Exception e) {
                standaloneFailed.put("close_system_dialogs: " + e.getMessage());
            }

            // 4. Attempt disabling animations via Settings.Global
            float winAnim = 1.0f;
            float transAnim = 1.0f;
            float durAnim = 1.0f;
            try {
                winAnim = android.provider.Settings.Global.getFloat(context.getContentResolver(), android.provider.Settings.Global.WINDOW_ANIMATION_SCALE, 1.0f);
                transAnim = android.provider.Settings.Global.getFloat(context.getContentResolver(), android.provider.Settings.Global.TRANSITION_ANIMATION_SCALE, 1.0f);
                durAnim = android.provider.Settings.Global.getFloat(context.getContentResolver(), android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1.0f);
            } catch (Exception ignored) {}

            try {
                android.provider.Settings.Global.putFloat(context.getContentResolver(), android.provider.Settings.Global.WINDOW_ANIMATION_SCALE, 0.0f);
                android.provider.Settings.Global.putFloat(context.getContentResolver(), android.provider.Settings.Global.TRANSITION_ANIMATION_SCALE, 0.0f);
                android.provider.Settings.Global.putFloat(context.getContentResolver(), android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 0.0f);
                standaloneSuccess.put("animation_scales_disabled");
            } catch (SecurityException se) {
                adbRequired.put("animation_scales (requires WRITE_SECURE_SETTINGS or ADB shell 'settings put global ...'; current: window=" + winAnim + ", transition=" + transAnim + ", animator=" + durAnim + ")");
            } catch (Exception e) {
                standaloneFailed.put("animation_scales: " + e.getMessage());
            }

            // 5. Reset VPN state if active
            try {
                HandyFarmVpnService.stopVpn(context);
                standaloneSuccess.put("vpn_disconnected");
            } catch (Exception e) {
                standaloneFailed.put("vpn: " + e.getMessage());
            }

            try {
                result.put("status", "OK");
                result.put("standalone_success", standaloneSuccess);
                result.put("adb_required", adbRequired);
                result.put("standalone_failed", standaloneFailed);
                setResultCode(Activity.RESULT_OK);
                setResultData(result.toString());
                Log.i(TAG, "Baseline reset completed: " + result.toString());
            } catch (Exception e) {
                setResultCode(Activity.RESULT_CANCELED);
                setResultData("ERROR: " + e.getMessage());
            }
            return;
        }

        // WireGuard VpnService control
        if (ACTION_VPN_CONNECT.equals(action)) {
            String targetPackage = intent.getStringExtra(HandyFarmVpnService.EXTRA_TARGET_PACKAGE);
            if (targetPackage == null || targetPackage.trim().isEmpty()) {
                setResultCode(Activity.RESULT_CANCELED);
                setResultData("ERROR: Missing target_package extra (--es target_package <pkg>)");
                return;
            }

            // Hard requirement: prevent self-lockout of adb shell and companion agent
            if ("com.android.shell".equals(targetPackage) || context.getPackageName().equals(targetPackage)) {
                setResultCode(Activity.RESULT_CANCELED);
                setResultData("ERROR: Self-lockout prevented: cannot route ADB shell or companion agent through VPN");
                return;
            }

            String serverEndpoint = intent.getStringExtra(HandyFarmVpnService.EXTRA_SERVER_ENDPOINT);
            if (serverEndpoint == null || serverEndpoint.trim().isEmpty()) {
                setResultCode(Activity.RESULT_CANCELED);
                setResultData("ERROR: Missing server_endpoint extra (--es server_endpoint <host:port>)");
                return;
            }

            // Check if VPN preparation is required
            Intent prepareIntent = android.net.VpnService.prepare(context);
            if (prepareIntent != null) {
                Log.w(TAG, "VPN preparation required. Run: adb shell settings put secure always_on_vpn_app com.handyfarm.clipper");
                setResultCode(Activity.RESULT_OK);
                setResultData("STATUS_PERMISSION_REQUIRED: VPN_PREPARATION (Run: adb shell settings put secure always_on_vpn_app com.handyfarm.clipper)");
                return;
            }

            Intent vpnIntent = new Intent(context, HandyFarmVpnService.class);
            vpnIntent.setAction(HandyFarmVpnService.ACTION_START);
            vpnIntent.putExtras(intent);

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(vpnIntent);
            } else {
                context.startService(vpnIntent);
            }

            try {
                Thread.sleep(500);
            } catch (InterruptedException ignored) {}

            JSONObject status = HandyFarmVpnService.getStatusJson();
            setResultCode(Activity.RESULT_OK);
            setResultData("OK: " + status.toString());
            return;
        }

        if (ACTION_VPN_DISCONNECT.equals(action)) {
            HandyFarmVpnService.stopVpn(context);
            setResultCode(Activity.RESULT_OK);
            setResultData("OK: VPN disconnected");
            return;
        }

        if (ACTION_VPN_STATUS.equals(action)) {
            JSONObject status = HandyFarmVpnService.getStatusJson();
            setResultCode(Activity.RESULT_OK);
            setResultData(status.toString());
            return;
        }

        // Phase 2: Observed egress detection over device's active route
        if (ACTION_EGRESS_GET.equals(action)) {
            JSONObject egress = new JSONObject();
            String transport = "unknown";
            boolean isCellular = false;
            boolean isWifi = false;
            boolean isVpn = false;

            try {
                android.net.ConnectivityManager cm = (android.net.ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
                if (cm != null) {
                    android.net.Network activeNet = cm.getActiveNetwork();
                    if (activeNet != null) {
                        android.net.NetworkCapabilities caps = cm.getNetworkCapabilities(activeNet);
                        if (caps != null) {
                            if (caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR)) {
                                transport = "cellular";
                                isCellular = true;
                            } else if (caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI)) {
                                transport = "wifi";
                                isWifi = true;
                            } else if (caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_VPN)) {
                                transport = "vpn";
                                isVpn = true;
                            }
                        }
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "Failed to query ConnectivityManager: " + e.getMessage());
            }

            String carrier = "unknown";
            try {
                android.telephony.TelephonyManager tm = (android.telephony.TelephonyManager) context.getSystemService(Context.TELEPHONY_SERVICE);
                if (tm != null) {
                    carrier = tm.getNetworkOperatorName();
                    if (carrier == null || carrier.isEmpty()) {
                        carrier = tm.getSimOperatorName();
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "Failed to query TelephonyManager: " + e.getMessage());
            }

            // Perform synchronous HTTP egress resolution
            android.os.StrictMode.ThreadPolicy oldPolicy = android.os.StrictMode.getThreadPolicy();
            android.os.StrictMode.setThreadPolicy(new android.os.StrictMode.ThreadPolicy.Builder().permitAll().build());
            try {
                egress.put("transport", transport);
                egress.put("isCellular", isCellular);
                egress.put("isWifi", isWifi);
                egress.put("isVpn", isVpn);
                egress.put("carrier", carrier);
                egress.put("observedAt", System.currentTimeMillis());

                JSONObject ipInfo = fetchHttpJson("https://ipinfo.io/json");
                if (ipInfo != null && ipInfo.has("ip")) {
                    egress.put("publicIp", ipInfo.optString("ip", ""));
                    egress.put("asn", ipInfo.optString("org", "unknown"));
                    JSONObject geo = new JSONObject();
                    geo.put("country", ipInfo.optString("country", ""));
                    geo.put("city", ipInfo.optString("city", ""));
                    geo.put("region", ipInfo.optString("region", ""));
                    geo.put("loc", ipInfo.optString("loc", ""));
                    egress.put("geo", geo);
                } else {
                    JSONObject ipify = fetchHttpJson("https://api.ipify.org?format=json");
                    if (ipify != null && ipify.has("ip")) {
                        egress.put("publicIp", ipify.optString("ip", ""));
                        egress.put("asn", "unknown");
                        egress.put("geo", new JSONObject());
                    } else {
                        egress.put("error", "EGRESS_RESOLUTION_FAILED");
                    }
                }
                setResultCode(Activity.RESULT_OK);
                setResultData(egress.toString());
            } catch (Exception e) {
                Log.e(TAG, "Failed to resolve observed egress", e);
                try {
                    egress.put("error", e.getMessage());
                } catch (Exception ignored) {}
                setResultCode(Activity.RESULT_OK);
                setResultData(egress.toString());
            } finally {
                android.os.StrictMode.setThreadPolicy(oldPolicy);
            }
            return;
        }

        ClipboardManager cm = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm == null) {
            setResultCode(Activity.RESULT_CANCELED);
            setResultData("ERROR: ClipboardManager unavailable");
            return;
        }

        if (ACTION_SET.equals(action) || ACTION_SET_SHORT.equals(action)) {
            String text = intent.getStringExtra(EXTRA_TEXT);
            if (text == null) {
                CharSequence cs = intent.getCharSequenceExtra(EXTRA_TEXT);
                if (cs != null) {
                    text = cs.toString();
                }
            }

            if (text != null) {
                try {
                    ClipData clip = ClipData.newPlainText("text", text);
                    cm.setPrimaryClip(clip);
                    setResultCode(Activity.RESULT_OK);
                    setResultData("Text is copied into clipboard.");
                    Log.i(TAG, "Copied " + text.length() + " chars to clipboard");
                } catch (Exception e) {
                    Log.e(TAG, "Failed to set clipboard", e);
                    setResultCode(Activity.RESULT_CANCELED);
                    setResultData("ERROR: " + e.getMessage());
                }
            } else {
                setResultCode(Activity.RESULT_CANCELED);
                setResultData("No text is provided. Use -e text \"text to be pasted\"");
            }
        } else if (ACTION_SET_PATH.equals(action)) {
            String path = intent.getStringExtra(EXTRA_PATH);
            if (path == null) {
                setResultCode(Activity.RESULT_CANCELED);
                setResultData("ERROR: missing 'path' extra");
                return;
            }
            // Hard pin to the tmp directory; refuse anything else.
            if (!path.startsWith(CLIPBOARD_TMP_DIR)) {
                setResultCode(Activity.RESULT_CANCELED);
                setResultData("ERROR: path must start with " + CLIPBOARD_TMP_DIR);
                Log.w(TAG, "Refused clipboard set-path outside tmp: " + path);
                return;
            }
            File f = new File(path);
            if (!f.exists() || !f.isFile()) {
                setResultCode(Activity.RESULT_CANCELED);
                setResultData("ERROR: file not found: " + path);
                return;
            }
            if (f.length() > 1024 * 1024) {
                // 1 MiB cap — way more than any plausible clipboard payload
                setResultCode(Activity.RESULT_CANCELED);
                setResultData("ERROR: file too large (" + f.length() + " bytes)");
                f.delete();
                return;
            }
            StringBuilder sb = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(new FileInputStream(f), "UTF-8"))) {
                int c;
                while ((c = reader.read()) != -1) {
                    sb.append((char) c);
                }
            } catch (Exception e) {
                setResultCode(Activity.RESULT_CANCELED);
                setResultData("ERROR: read failed: " + e.getMessage());
                return;
            }
            String text = sb.toString();
            try {
                ClipData clip = ClipData.newPlainText("text", text);
                cm.setPrimaryClip(clip);
                setResultCode(Activity.RESULT_OK);
                setResultData("OK:" + text.length());
                Log.i(TAG, "Copied " + text.length() + " chars to clipboard from " + path);
            } catch (Exception e) {
                setResultCode(Activity.RESULT_CANCELED);
                setResultData("ERROR: clipboard set failed: " + e.getMessage());
                return;
            } finally {
                // Always clean up, even if clipboard set failed
                f.delete();
            }
        } else if (ACTION_GET.equals(action) || ACTION_GET_SHORT.equals(action)) {
            try {
                ClipData clip = cm.getPrimaryClip();
                if (clip != null && clip.getItemCount() > 0) {
                    CharSequence text = clip.getItemAt(0).coerceToText(context);
                    String result = text != null ? text.toString() : "";
                    setResultCode(Activity.RESULT_OK);
                    setResultData(result);
                    Log.i(TAG, "Read " + result.length() + " chars from clipboard");
                } else {
                    setResultCode(Activity.RESULT_OK);
                    setResultData("");
                    Log.i(TAG, "Clipboard empty or null");
                }
            } catch (Exception e) {
                Log.e(TAG, "Failed to read clipboard", e);
                setResultCode(Activity.RESULT_CANCELED);
                setResultData("");
            }
        }
    }

    private JSONObject fetchHttpJson(String urlStr) {
        java.net.HttpURLConnection conn = null;
        try {
            java.net.URL url = new java.net.URL(urlStr);
            conn = (java.net.HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setRequestProperty("User-Agent", "curl/7.88.1 HandyFarm/2.0");
            conn.setRequestProperty("Accept", "application/json");
            conn.setConnectTimeout(4000);
            conn.setReadTimeout(4000);
            int code = conn.getResponseCode();
            if (code == 200) {
                java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.InputStreamReader(conn.getInputStream()));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) {
                    sb.append(line);
                }
                reader.close();
                return new JSONObject(sb.toString());
            }
        } catch (Exception ignored) {
        } finally {
            if (conn != null) {
                try { conn.disconnect(); } catch (Exception ignored) {}
            }
        }
        return null;
    }
}
