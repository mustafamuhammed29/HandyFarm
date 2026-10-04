package com.wireguard.android.backend;

import android.util.Log;

public final class GoBackend {
    private static final String TAG = "HandyFarmVpn";
    private static boolean loaded = false;

    static {
        try {
            System.loadLibrary("wg-go");
            loaded = true;
            Log.i(TAG, "libwg-go.so successfully loaded");
        } catch (Throwable t) {
            Log.e(TAG, "Failed to load libwg-go.so", t);
        }
    }

    public static boolean isLoaded() {
        return loaded;
    }

    public static native int wgTurnOn(String ifName, int tunFd, String settings);
    public static native void wgTurnOff(int handle);
    public static native int wgGetSocketV4(int handle);
    public static native int wgGetSocketV6(int handle);
    public static native String wgGetConfig(int handle);
    public static native String wgVersion();
}
