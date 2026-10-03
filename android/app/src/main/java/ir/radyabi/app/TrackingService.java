package ir.radyabi.app;

import android.app.Service;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import org.json.JSONObject;
import java.util.concurrent.atomic.AtomicBoolean;

public final class TrackingService extends Service implements LocationListener {
    static final String STOP = "ir.radyabi.app.STOP";
    private static final int NOTIFICATION = 10;
    private State state;
    private LocationManager locations;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean listening = false;
    private final AtomicBoolean uploading = new AtomicBoolean(false);
    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (!state.sharing() || !state.alwaysPermission()) {
                stopSharing(TrackingService.this); stopSelf(); return;
            }
            if (!state.locationEnabled()) updateStatus("مکان‌یابی گوشی خاموش است؛ GPS را روشن کنید.");
            else uploadLatest();
            handler.postDelayed(this, 30000);
        }
    };
    @Override public void onCreate() {
        super.onCreate(); state = new State(this); locations = getSystemService(LocationManager.class);
        getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel("location", "اشتراک موقعیت", NotificationManager.IMPORTANCE_LOW));
    }
    private Notification notification(String text) {
        PendingIntent open = PendingIntent.getActivity(this, 1, new Intent(this, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 2, new Intent(this, TrackingService.class).setAction(STOP), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this,"location").setSmallIcon(R.drawable.ic_notification).setContentTitle("ارسال موقعیت به مدیر سامانه")
            .setContentText(text).setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true)
            .addAction(new Notification.Action.Builder(null,"توقف ارسال",stop).build()).build();
    }
    private void updateStatus(String text) {
        state.status(text); getSystemService(NotificationManager.class).notify(NOTIFICATION, notification(text));
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && STOP.equals(intent.getAction())) { stopSharing(this); stopSelf(); return START_NOT_STICKY; }
        if (!state.registered() || !state.sharing() || !state.alwaysPermission()) { stopSelf(); return START_NOT_STICKY; }
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION, notification("در انتظار دریافت موقعیت…"), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            else startForeground(NOTIFICATION, notification("در انتظار دریافت موقعیت…"));
            if (!listening) {
                listening = true;
                for (String provider : new String[]{LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER}) {
                    if (locations.getAllProviders().contains(provider)) locations.requestLocationUpdates(provider,15000,0,this,Looper.getMainLooper());
                }
                handler.post(tick);
            }
        } catch (SecurityException e) { state.status("مجوز مکان لغو شده است."); stopSharing(this); stopSelf(); return START_NOT_STICKY; }
        return START_STICKY;
    }
    @Override public void onLocationChanged(Location location) {
        if (!state.sharing() || !state.alwaysPermission()) return;
        if (location.isFromMockProvider()) { updateStatus("موقعیت آزمایشی به سامانه ارسال نمی‌شود."); return; }
        JSONObject old = state.location();
        if (old.optLong("capturedAt",0) > location.getTime()) return;
        try {
            JSONObject sample = new JSONObject().put("latitude", location.getLatitude()).put("longitude", location.getLongitude())
                .put("accuracy", location.getAccuracy()).put("capturedAt", location.getTime());
            Intent battery = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (battery != null) {
                int level=battery.getIntExtra(BatteryManager.EXTRA_LEVEL,-1), scale=battery.getIntExtra(BatteryManager.EXTRA_SCALE,-1);
                if(level>=0&&scale>0) sample.put("battery", Math.round(level*100f/scale));
            }
            state.prefs.edit().putString("location", sample.toString()).apply();
            if (System.currentTimeMillis()-state.prefs.getLong("last_sent",0) >= 15000) uploadLatest();
        } catch (Exception e) { updateStatus("دریافت موقعیت انجام نشد."); }
    }
    private void uploadLatest() {
        if (!state.location().has("latitude")) { updateStatus("در انتظار دریافت موقعیت از گوشی…"); return; }
        if (!uploading.compareAndSet(false,true)) return;
        Api.IO.execute(() -> {
            try {
                if (!state.sharing() || !state.alwaysPermission()) return;
                JSONObject sample = state.location();
                Api.device(this,"/api/device/location",sample);
                state.prefs.edit().putLong("last_sent", System.currentTimeMillis()).apply();
                handler.post(() -> { if(state.sharing()) updateStatus("موقعیت ارسال شد؛ اشتراک در پس‌زمینه فعال است."); });
            } catch (Api.Failure e) {
                if(e.status==401||e.status==403) handler.post(() -> { state.status(e.getMessage()); stopSharing(this); stopSelf(); });
                else handler.post(() -> { if(state.sharing()) updateStatus("ارسال انجام نشد؛ پس از اتصال دوباره تلاش می‌شود."); });
            } catch (Exception e) {
                handler.post(() -> { if(state.sharing()) updateStatus("اینترنت قطع است؛ آخرین موقعیت پس از اتصال ارسال می‌شود."); });
            } finally { uploading.set(false); }
        });
    }
    static void stopSharing(Context context) {
        Context app = context.getApplicationContext(); State state = new State(app);
        state.prefs.edit().putBoolean("sharing",false).putBoolean("pending_revoke",state.registered()).putString("status","ارسال موقعیت متوقف شده است.").commit();
        app.stopService(new Intent(app,TrackingService.class));
        ConsentSyncJob.schedule(app);
        Api.IO.execute(() -> { try { Api.flushRevocation(app); } catch (Exception ignored) {} });
    }
    @Override public void onProviderEnabled(String provider) { if(state.sharing()) updateStatus("در انتظار موقعیت تازه…"); }
    @Override public void onProviderDisabled(String provider) { if(state.sharing()&&!state.locationEnabled()) updateStatus("مکان‌یابی گوشی خاموش است."); }
    @Override public void onStatusChanged(String provider,int status,Bundle extras) {}
    @Override public void onDestroy() { handler.removeCallbacksAndMessages(null); if(locations!=null)locations.removeUpdates(this); stopForeground(STOP_FOREGROUND_REMOVE);super.onDestroy(); }
    @Override public IBinder onBind(Intent intent) { return null; }
}
