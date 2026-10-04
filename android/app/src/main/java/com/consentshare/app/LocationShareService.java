package com.consentshare.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONObject;

public class LocationShareService extends Service implements LocationListener {
    public static final String ACTION_START = "com.consentshare.app.START";
    public static final String ACTION_STOP = "com.consentshare.app.STOP";
    private static final String CHANNEL_ID = "active_location_share";
    private static final int NOTIFICATION_ID = 71;

    private LocationManager locationManager;
    private SharedPreferences prefs;
    private volatile boolean stopped = false;

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = getSharedPreferences("consent_share", MODE_PRIVATE);
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "اشتراک فعال موقعیت", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("هنگام ارسال رضایت‌محور موقعیت نمایش داده می‌شود");
            manager.createNotificationChannel(channel);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopSharing(true);
            return START_NOT_STICKY;
        }

        if (!prefs.getBoolean("active", false) || prefs.getString("device_token", "").length() < 20) {
            stopSelf();
            return START_NOT_STICKY;
        }

        stopped = false;
        showForegroundNotification();
        startLocationUpdates();
        return START_STICKY;
    }

    private void showForegroundNotification() {
        Intent openIntent = new Intent(this, MainActivity.class);
        PendingIntent open = PendingIntent.getActivity(this, 1, openIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent stopIntent = new Intent(this, LocationShareService.class);
        stopIntent.setAction(ACTION_STOP);
        PendingIntent stop = PendingIntent.getService(this, 2, stopIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL_ID) : new Notification.Builder(this);
        Notification notification = builder
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("اشتراک موقعیت فعال است")
            .setContentText("مدت: " + durationLabel(prefs.getString("duration_mode", "2h")) + " — برای پایان، «توقف اشتراک» را بزنید.")
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel, "توقف اشتراک", stop).build())
            .build();

        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void startLocationUpdates() {
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            stopSharing(true);
            return;
        }
        locationManager = (LocationManager) getSystemService(LOCATION_SERVICE);
        try {
            locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 10000, 10, this);
            locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 15000, 20, this);
        } catch (Exception e) {
            stopSharing(true);
        }
    }

    @Override
    public void onLocationChanged(Location location) {
        String deviceToken = prefs.getString("device_token", "");
        if (deviceToken.length() < 20 || stopped) return;

        new Thread(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("action", "update");
                body.put("device_token", deviceToken);
                body.put("latitude", location.getLatitude());
                body.put("longitude", location.getLongitude());
                body.put("accuracy_m", location.hasAccuracy() ? location.getAccuracy() : JSONObject.NULL);
                JSONObject result = ApiClient.post(body);
                if (!result.optBoolean("ok") && "SESSION_INACTIVE".equals(result.optString("error"))) {
                    stopSharing(false);
                }
            } catch (Exception ignored) {}
        }).start();
    }

    private void stopSharing(boolean notifyServer) {
        if (stopped) return;
        stopped = true;
        if (locationManager != null) {
            try { locationManager.removeUpdates(this); } catch (Exception ignored) {}
        }

        String deviceToken = prefs.getString("device_token", "");
        prefs.edit().putBoolean("active", false).remove("device_token").remove("expires_at").apply();

        if (notifyServer && deviceToken.length() >= 20) {
            new Thread(() -> {
                try {
                    JSONObject body = new JSONObject();
                    body.put("action", "stop");
                    body.put("device_token", deviceToken);
                    ApiClient.post(body);
                } catch (Exception ignored) {}
            }).start();
        }

        stopForeground(true);
        stopSelf();
    }

    private String durationLabel(String mode) {
        if ("5h".equals(mode)) return "۵ ساعت";
        if ("10h".equals(mode)) return "۱۰ ساعت";
        if ("manual".equals(mode)) return "تا زمان خاموش‌کردن";
        return "۲ ساعت";
    }

    @Override
    public void onDestroy() {
        if (locationManager != null) {
            try { locationManager.removeUpdates(this); } catch (Exception ignored) {}
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
