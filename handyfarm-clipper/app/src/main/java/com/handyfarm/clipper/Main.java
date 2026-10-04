package com.handyfarm.clipper;

import android.app.Activity;
import android.content.Intent;
import android.net.VpnService;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Window;
import android.view.WindowManager;

public class Main extends Activity {
    private static final int REQUEST_VPN_PREPARE = 200;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Disable all window transition animations for seamless focus acquisition
        overridePendingTransition(0, 0);

        Intent intent = getIntent();
        if (intent != null && "handyfarm.action.PREPARE_VPN".equals(intent.getAction())) {
            Intent prep = VpnService.prepare(this);
            if (prep != null) {
                startActivityForResult(prep, REQUEST_VPN_PREPARE);
                return;
            } else {
                finish();
                return;
            }
        }

        Window window = getWindow();
        if (window != null) {
            window.addFlags(
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL |
                WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH
            );
        }

        // Safety timeout: auto-finish after 3 seconds if Electron hasn't already sent KEYCODE_BACK
        new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
            @Override
            public void run() {
                if (!isFinishing()) {
                    finish();
                    overridePendingTransition(0, 0);
                }
            }
        }, 3000);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_VPN_PREPARE) {
            finish();
        }
    }

    @Override
    public void finish() {
        super.finish();
        overridePendingTransition(0, 0);
    }
}
