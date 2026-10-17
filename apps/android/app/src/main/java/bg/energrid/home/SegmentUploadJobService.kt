package bg.energrid.home

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context

internal object SegmentUploadScheduler {
    private const val JOB_ID = 8417

    fun schedule(context: Context) {
        val scheduler = context.getSystemService(JobScheduler::class.java) ?: return
        val job = JobInfo.Builder(JOB_ID, ComponentName(context, SegmentUploadJobService::class.java))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setBackoffCriteria(60_000L, JobInfo.BACKOFF_POLICY_LINEAR)
            .setPersisted(true)
            .build()
        scheduler.schedule(job)
    }
}

class SegmentUploadJobService : JobService() {
    private var queue: SegmentUploadQueue? = null

    override fun onStartJob(params: JobParameters): Boolean {
        val worker = SegmentUploadQueue(applicationContext)
        queue = worker
        worker.enqueuePending { retry ->
            jobFinished(params, retry)
            if (queue === worker) queue = null
            worker.close()
        }
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean {
        queue?.close()
        queue = null
        return true
    }
}
