package com.handyfarm.clipper;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.VpnService;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.util.Base64;
import android.util.Log;

import com.wireguard.android.backend.GoBackend;

import org.json.JSONObject;

import java.io.IOException;

public class HandyFarmVpnService extends VpnService {
    private static final String TAG = "HandyFarmVpn";
    private static final String CHANNEL_ID = "handyfarm_vpn_channel";
    private static final int NOTIFICATION_ID = 4040;

    public static final String ACTION_START = "handyfarm.vpn.service.START";
    public static final String ACTION_STOP = "handyfarm.vpn.service.STOP";

    public static final String EXTRA_TARGET_PACKAGE = "target_package";
    public static final String EXTRA_SERVER_ENDPOINT = "server_endpoint";
    public static final String EXTRA_CLIENT_PRIVATE_KEY = "client_private_key";
    public static final String EXTRA_SERVER_PUBLIC_KEY = "server_public_key";
    public static final String EXTRA_TUNNEL_IP = "tunnel_ip";
    public static final String EXTRA_ALLOWED_IP = "allowed_ip";
    public static final String EXTRA_DNS = "dns";

    // Global tunnel state tracking
    public static volatile String sState = "DISCONNECTED"; // DISCONNECTED, CONNECTING, CONNECTED, ERROR
    public static volatile String sTargetPackage = null;
    public static volatile String sServerEndpoint = null;
    public static volatile String sTunnelIp = null;
    public static volatile int sHandle = -1;
    public static volatile String sLastError = null;
    public static volatile long sConnectedSince = 0;

    private ParcelFileDescriptor mInterfacePfd = null;
    private int mCurrentHandle = -1;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "HandyFarm VPN Service",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Background WireGuard VPN tunnel for HandyFarm");
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.createNotificationChannel(channel);
            }
        }
    }

    private Notification buildNotification(String text) {
        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new Notification.Builder(this, CHANNEL_ID);
        } else {
            builder = new Notification.Builder(this);
        }
        return builder
            .setContentTitle("HandyFarm WireGuard VPN")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setOngoing(true)
            .build();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_NOT_STICKY;

        String action = intent.getAction();
        if (ACTION_START.equals(action)) {
            startVpnTunnel(intent);
        } else if (ACTION_STOP.equals(action)) {
            stopVpnTunnel();
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    private synchronized void startVpnTunnel(Intent intent) {
        String targetPackage = intent.getStringExtra(EXTRA_TARGET_PACKAGE);
        String serverEndpoint = intent.getStringExtra(EXTRA_SERVER_ENDPOINT);
        String clientPrivateKey = intent.getStringExtra(EXTRA_CLIENT_PRIVATE_KEY);
        String serverPublicKey = intent.getStringExtra(EXTRA_SERVER_PUBLIC_KEY);
        String tunnelIp = intent.getStringExtra(EXTRA_TUNNEL_IP);
        String allowedIp = intent.getStringExtra(EXTRA_ALLOWED_IP);
        String dns = intent.getStringExtra(EXTRA_DNS);

        if (tunnelIp == null || tunnelIp.isEmpty()) tunnelIp = "10.0.0.2";
        if (allowedIp == null || allowedIp.isEmpty()) allowedIp = "0.0.0.0/0";
        if (dns == null || dns.isEmpty()) dns = "1.1.1.1";

        sState = "CONNECTING";
        sTargetPackage = targetPackage;
        sServerEndpoint = serverEndpoint;
        sTunnelIp = tunnelIp;
        sLastError = null;

        Log.i(TAG, "Starting VPN tunnel: target=" + targetPackage + ", endpoint=" + serverEndpoint + ", tunnelIp=" + tunnelIp);

        // Ensure libwg-go is loaded
        if (!GoBackend.isLoaded()) {
            sState = "ERROR";
            sLastError = "libwg-go.so native library failed to load";
            Log.e(TAG, sLastError);
            return;
        }

        // Validate target package
        if (targetPackage == null || targetPackage.isEmpty()) {
            sState = "ERROR";
            sLastError = "Missing target_package parameter";
            Log.e(TAG, sLastError);
            return;
        }

        // Hard requirement: prevent self-lockout of adb shell and companion agent
        if ("com.android.shell".equals(targetPackage) || getPackageName().equals(targetPackage)) {
            sState = "ERROR";
            sLastError = "Self-lockout prevented: cannot route ADB shell or companion agent through VPN";
            Log.e(TAG, sLastError);
            return;
        }

        try {
            getPackageManager().getPackageInfo(targetPackage, 0);
        } catch (PackageManager.NameNotFoundException e) {
            sState = "ERROR";
            sLastError = "Target package not installed on device: " + targetPackage;
            Log.e(TAG, sLastError);
            return;
        }

        // Teardown any existing active tunnel before creating new one
        if (mCurrentHandle >= 0) {
            try {
                GoBackend.wgTurnOff(mCurrentHandle);
            } catch (Exception ignored) {}
            mCurrentHandle = -1;
        }
        if (mInterfacePfd != null) {
            try {
                mInterfacePfd.close();
            } catch (IOException ignored) {}
            mInterfacePfd = null;
        }

        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, buildNotification("Routing traffic for " + targetPackage), android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, buildNotification("Routing traffic for " + targetPackage));
        }

        try {
            Builder builder = new Builder();
            builder.setSession("HandyFarm-" + targetPackage);
            builder.addAddress(tunnelIp, 24);
            builder.addRoute("0.0.0.0", 0);
            builder.addDnsServer(dns);
            builder.setMtu(1420);
            builder.setBlocking(false);

            // Per-app split tunneling: ONLY route targetPackage
            builder.addAllowedApplication(targetPackage);

            // Establish virtual network interface
            mInterfacePfd = builder.establish();
            if (mInterfacePfd == null) {
                sState = "ERROR";
                sLastError = "VpnService.Builder.establish() returned null (VPN not prepared or revoked)";
                Log.e(TAG, sLastError);
                return;
            }

            int tunFd = mInterfacePfd.detachFd();
            String uapiSettings = formatUapiConfig(clientPrivateKey, serverPublicKey, serverEndpoint, allowedIp);
            Log.d(TAG, "WireGuard UAPI configuration:\n" + uapiSettings);

            // Start WireGuard userspace engine via JNI
            int handle = GoBackend.wgTurnOn("wg0", tunFd, uapiSettings);
            if (handle < 0) {
                sState = "ERROR";
                sLastError = "wgTurnOn failed with error code: " + handle;
                Log.e(TAG, sLastError);
                return;
            }

            mCurrentHandle = handle;
            sHandle = handle;

            // Protect the WireGuard UDP socket from looping back into the VPN tunnel
            int socketV4 = GoBackend.wgGetSocketV4(handle);
            if (socketV4 > 0) {
                boolean protectedV4 = protect(socketV4);
                Log.i(TAG, "Protected WireGuard IPv4 socket fd=" + socketV4 + ", result=" + protectedV4);
            }
            int socketV6 = GoBackend.wgGetSocketV6(handle);
            if (socketV6 > 0) {
                boolean protectedV6 = protect(socketV6);
                Log.i(TAG, "Protected WireGuard IPv6 socket fd=" + socketV6 + ", result=" + protectedV6);
            }

            sState = "CONNECTED";
            sConnectedSince = System.currentTimeMillis();
            Log.i(TAG, "WireGuard VPN tunnel established successfully (handle=" + handle + ") for " + targetPackage);
        } catch (Exception e) {
            sState = "ERROR";
            sLastError = "Failed to establish VPN: " + e.getMessage();
            Log.e(TAG, sLastError, e);
        }
    }

    private synchronized void stopVpnTunnel() {
        Log.i(TAG, "Stopping VPN tunnel...");
        if (mCurrentHandle >= 0) {
            try {
                GoBackend.wgTurnOff(mCurrentHandle);
                Log.i(TAG, "wgTurnOff called for handle=" + mCurrentHandle);
            } catch (Exception e) {
                Log.w(TAG, "Error in wgTurnOff", e);
            }
            mCurrentHandle = -1;
        }

        if (mInterfacePfd != null) {
            try {
                mInterfacePfd.close();
            } catch (Exception ignored) {}
            mInterfacePfd = null;
        }

        sState = "DISCONNECTED";
        sHandle = -1;
        sTargetPackage = null;
        sConnectedSince = 0;
        stopForeground(true);
        Log.i(TAG, "VPN tunnel stopped cleanly");
    }

    @Override
    public void onDestroy() {
        stopVpnTunnel();
        super.onDestroy();
    }

    public static String formatUapiConfig(String clientPrivateKey, String serverPublicKey, String serverEndpoint, String allowedIp) {
        String privKeyHex = toHexKey(clientPrivateKey);
        String pubKeyHex = toHexKey(serverPublicKey);

        StringBuilder sb = new StringBuilder();
        sb.append("private_key=").append(privKeyHex).append("\n");
        sb.append("listen_port=0\n");
        sb.append("replace_peers=true\n");
        sb.append("public_key=").append(pubKeyHex).append("\n");
        sb.append("endpoint=").append(serverEndpoint).append("\n");
        if (allowedIp != null && !allowedIp.isEmpty()) {
            sb.append("allowed_ip=").append(allowedIp).append("\n");
        } else {
            sb.append("allowed_ip=0.0.0.0/0\n");
        }
        sb.append("persistent_keepalive_interval=25\n");
        return sb.toString();
    }

    public static String toHexKey(String key) {
        if (key == null) return "";
        key = key.trim();
        // 64-char hex
        if (key.length() == 64 && key.matches("^[0-9a-fA-F]+$")) {
            return key.toLowerCase();
        }
        // Base64
        try {
            byte[] decoded = Base64.decode(key, Base64.DEFAULT);
            if (decoded.length == 32) {
                StringBuilder hex = new StringBuilder(64);
                for (byte b : decoded) {
                    hex.append(String.format("%02x", b & 0xff));
                }
                return hex.toString();
            }
        } catch (Exception ignored) {}
        return key;
    }

    public static JSONObject getStatusJson() {
        JSONObject json = new JSONObject();
        try {
            json.put("status", sState);
            json.put("target_package", sTargetPackage != null ? sTargetPackage : "");
            json.put("server_endpoint", sServerEndpoint != null ? sServerEndpoint : "");
            json.put("tunnel_ip", sTunnelIp != null ? sTunnelIp : "");
            json.put("handle", sHandle);
            json.put("uptime_ms", sConnectedSince > 0 ? (System.currentTimeMillis() - sConnectedSince) : 0);
            json.put("split_tunnel", true);
            json.put("backend_loaded", GoBackend.isLoaded());
            if (GoBackend.isLoaded()) {
                try {
                    json.put("backend_version", GoBackend.wgVersion());
                } catch (Throwable ignored) {}
            }
            if (sLastError != null) {
                json.put("error", sLastError);
            }
        } catch (Exception ignored) {}
        return json;
    }

    public static void stopVpn(Context context) {
        Intent intent = new Intent(context, HandyFarmVpnService.class);
        intent.setAction(ACTION_STOP);
        context.startService(intent);
        sState = "DISCONNECTED";
    }
}
