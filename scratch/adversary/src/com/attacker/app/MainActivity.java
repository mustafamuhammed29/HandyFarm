package com.attacker.app;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;

public class MainActivity extends Activity {
    private static final String TAG = "AdversaryTest";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Log.i(TAG, "Adversary app started with UID=" + android.os.Process.myUid());

        // 1. Attempt to send unauthorized clipper.set
        Intent setIntent = new Intent("clipper.set");
        setIntent.setComponent(new ComponentName("com.handyfarm.clipper", "com.handyfarm.clipper.ClipperReceiver"));
        setIntent.putExtra("text", "MALICIOUS_OVERWRITE_ATTACK");

        Log.i(TAG, "Sending unauthorized clipper.set broadcast...");
        sendOrderedBroadcast(setIntent, null, new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                int code = getResultCode();
                String data = getResultData();
                Log.i(TAG, "clipper.set result: code=" + code + ", data=" + data);
            }
        }, null, 0, null, null);

        // 2. Attempt to send unauthorized clipper.get
        Intent getIntent = new Intent("clipper.get");
        getIntent.setComponent(new ComponentName("com.handyfarm.clipper", "com.handyfarm.clipper.ClipperReceiver"));

        Log.i(TAG, "Sending unauthorized clipper.get broadcast...");
        sendOrderedBroadcast(getIntent, null, new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                int code = getResultCode();
                String data = getResultData();
                Log.i(TAG, "clipper.get result: code=" + code + ", data=" + data);
            }
        }, null, 0, null, null);

        // 3. Attempt to send unauthorized handyfarm.identity.get
        Intent identityIntent = new Intent("handyfarm.identity.get");
        identityIntent.setComponent(new ComponentName("com.handyfarm.clipper", "com.handyfarm.clipper.ClipperReceiver"));

        Log.i(TAG, "Sending unauthorized handyfarm.identity.get broadcast...");
        sendOrderedBroadcast(identityIntent, null, new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                int code = getResultCode();
                String data = getResultData();
                Log.i(TAG, "identity.get result: code=" + code + ", data=" + data);
            }
        }, null, 0, null, null);

        // 4. Attempt to send unauthorized handyfarm.foreground.get
        Intent foregroundIntent = new Intent("handyfarm.foreground.get");
        foregroundIntent.setComponent(new ComponentName("com.handyfarm.clipper", "com.handyfarm.clipper.ClipperReceiver"));

        Log.i(TAG, "Sending unauthorized handyfarm.foreground.get broadcast...");
        sendOrderedBroadcast(foregroundIntent, null, new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                int code = getResultCode();
                String data = getResultData();
                Log.i(TAG, "foreground.get result: code=" + code + ", data=" + data);
            }
        }, null, 0, null, null);

        // 5. Attempt to send unauthorized handyfarm.location.set
        Intent locationSetIntent = new Intent("handyfarm.location.set");
        locationSetIntent.setComponent(new ComponentName("com.handyfarm.clipper", "com.handyfarm.clipper.ClipperReceiver"));
        locationSetIntent.putExtra("lat", 99.99f);
        locationSetIntent.putExtra("lng", 99.99f);

        Log.i(TAG, "Sending unauthorized handyfarm.location.set broadcast...");
        sendOrderedBroadcast(locationSetIntent, null, new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                int code = getResultCode();
                String data = getResultData();
                Log.i(TAG, "location.set result: code=" + code + ", data=" + data);
            }
        }, null, 0, null, null);

        // 6. Attempt to send unauthorized handyfarm.location.get
        Intent locationGetIntent = new Intent("handyfarm.location.get");
        locationGetIntent.setComponent(new ComponentName("com.handyfarm.clipper", "com.handyfarm.clipper.ClipperReceiver"));

        Log.i(TAG, "Sending unauthorized handyfarm.location.get broadcast...");
        sendOrderedBroadcast(locationGetIntent, null, new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                int code = getResultCode();
                String data = getResultData();
                Log.i(TAG, "location.get result: code=" + code + ", data=" + data);
            }
        }, null, 0, null, null);

        // 7. Attempt to send unauthorized handyfarm.reset.baseline
        Intent resetIntent = new Intent("handyfarm.reset.baseline");
        resetIntent.setComponent(new ComponentName("com.handyfarm.clipper", "com.handyfarm.clipper.ClipperReceiver"));

        Log.i(TAG, "Sending unauthorized handyfarm.reset.baseline broadcast...");
        sendOrderedBroadcast(resetIntent, null, new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                int code = getResultCode();
                String data = getResultData();
                Log.i(TAG, "reset.baseline result: code=" + code + ", data=" + data);
            }
        }, null, 0, null, null);

        // 8. Attempt to send unauthorized handyfarm.vpn.connect
        Intent vpnConnectIntent = new Intent("handyfarm.vpn.connect");
        vpnConnectIntent.setComponent(new ComponentName("com.handyfarm.clipper", "com.handyfarm.clipper.ClipperReceiver"));
        vpnConnectIntent.putExtra("target_package", "com.android.chrome");
        vpnConnectIntent.putExtra("server_endpoint", "1.2.3.4:51820");

        Log.i(TAG, "Sending unauthorized handyfarm.vpn.connect broadcast...");
        sendOrderedBroadcast(vpnConnectIntent, null, new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                int code = getResultCode();
                String data = getResultData();
                Log.i(TAG, "vpn.connect result: code=" + code + ", data=" + data);
            }
        }, null, 0, null, null);

        // 9. Attempt to send unauthorized handyfarm.vpn.disconnect
        Intent vpnDisconnectIntent = new Intent("handyfarm.vpn.disconnect");
        vpnDisconnectIntent.setComponent(new ComponentName("com.handyfarm.clipper", "com.handyfarm.clipper.ClipperReceiver"));

        Log.i(TAG, "Sending unauthorized handyfarm.vpn.disconnect broadcast...");
        sendOrderedBroadcast(vpnDisconnectIntent, null, new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                int code = getResultCode();
                String data = getResultData();
                Log.i(TAG, "vpn.disconnect result: code=" + code + ", data=" + data);
            }
        }, null, 0, null, null);

        // 10. Attempt to send unauthorized handyfarm.vpn.status
        Intent vpnStatusIntent = new Intent("handyfarm.vpn.status");
        vpnStatusIntent.setComponent(new ComponentName("com.handyfarm.clipper", "com.handyfarm.clipper.ClipperReceiver"));

        Log.i(TAG, "Sending unauthorized handyfarm.vpn.status broadcast...");
        sendOrderedBroadcast(vpnStatusIntent, null, new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                int code = getResultCode();
                String data = getResultData();
                Log.i(TAG, "vpn.status result: code=" + code + ", data=" + data);
            }
        }, null, 0, null, null);
    }
}
