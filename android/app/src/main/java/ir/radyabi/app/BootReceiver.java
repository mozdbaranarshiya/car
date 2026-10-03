package ir.radyabi.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        State state = new State(context);
        if (state.pendingRevoke()) ConsentSyncJob.schedule(context);
        if (state.registered() && state.sharing() && state.alwaysPermission()) {
            try { context.startForegroundService(new Intent(context, TrackingService.class)); }
            catch (RuntimeException e) { state.status("برای ادامهٔ ارسال، برنامه را باز کنید."); }
        }
    }
}
