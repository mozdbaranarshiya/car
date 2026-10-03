package ir.radyabi.app;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

public final class ConsentSyncJob extends JobService {
    static void schedule(Context context) {
        context.getSystemService(JobScheduler.class).schedule(new JobInfo.Builder(2026, new ComponentName(context, ConsentSyncJob.class))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPersisted(true)
            .setBackoffCriteria(30000, JobInfo.BACKOFF_POLICY_EXPONENTIAL).build());
    }
    @Override public boolean onStartJob(JobParameters params) {
        Api.IO.execute(() -> {
            boolean retry = false;
            try { Api.flushRevocation(this); } catch (Exception e) { retry = true; }
            jobFinished(params, retry);
        });
        return true;
    }
    @Override public boolean onStopJob(JobParameters params) { return true; }
}
