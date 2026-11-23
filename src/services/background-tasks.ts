import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { openDatabase } from '../data/database';
import { ArticleRepository } from '../data/repositories/article-repository';
import { CatalogRepository } from '../data/repositories/catalog-repository';
import { SettingsRepository } from '../data/repositories/settings-repository';
import {
  runWifiPrefetchAndPurge,
  type WifiPrefetchAndPurgeResult,
} from './prefetch-service';
import { createTimeoutFetcher, getRemoteConfig } from './remote-config';
import { syncAllFeeds, type SyncAllFeedsResult } from './sync-service';

/**
 * Periodic feed refresh + keyword notification task (`BGAppRefreshTask` equivalent).
 */
export const BACKGROUND_SYNC_TASK_NAME = 'musubi-background-sync';

/**
 * Wi-Fi prefetch + TTL/LRU cache purge task (`BGProcessingTask` equivalent).
 */
export const BACKGROUND_PREFETCH_TASK_NAME = 'musubi-background-prefetch';

export const SYNC_TASK_MINIMUM_INTERVAL_MINUTES = 30;
export const PREFETCH_TASK_MINIMUM_INTERVAL_MINUTES = 120;

export interface TaskManagerLike {
  isTaskDefined(taskName: string): boolean;
  defineTask(taskName: string, taskExecutor: () => Promise<unknown>): void;
  isTaskRegisteredAsync(taskName: string): Promise<boolean>;
}

export interface BackgroundTaskLike {
  getStatusAsync(): Promise<BackgroundTask.BackgroundTaskStatus>;
  registerTaskAsync(
    taskName: string,
    options?: BackgroundTask.BackgroundTaskOptions
  ): Promise<void>;
}

export interface BackgroundTaskRegistrationDeps {
  taskManager?: TaskManagerLike;
  backgroundTask?: BackgroundTaskLike;
}

async function createRepositories() {
  const db = await openDatabase();
  return {
    catalogRepo: new CatalogRepository(db),
    articleRepo: new ArticleRepository(db),
    settingsRepo: new SettingsRepository(db),
  };
}

/**
 * Executes the background feed sync task and maps outcome to `BackgroundTaskResult`.
 */
export async function executeBackgroundSyncTask(
  runSync?: () => Promise<SyncAllFeedsResult>
): Promise<BackgroundTask.BackgroundTaskResult> {
  try {
    if (runSync) {
      await runSync();
    } else {
      const { catalogRepo, articleRepo, settingsRepo } =
        await createRepositories();
      const { catalogUrl } = getRemoteConfig();
      if (catalogUrl) {
        await catalogRepo
          .refreshFromRemote(catalogUrl, createTimeoutFetcher())
          .catch(() => {});
      }
      await syncAllFeeds({ catalogRepo, articleRepo, settingsRepo });
    }
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
}

/**
 * Executes the background Wi-Fi prefetch & purge task and maps outcome to `BackgroundTaskResult`.
 */
export async function executeBackgroundPrefetchTask(
  runPrefetch?: () => Promise<WifiPrefetchAndPurgeResult>
): Promise<BackgroundTask.BackgroundTaskResult> {
  try {
    if (runPrefetch) {
      await runPrefetch();
    } else {
      const { articleRepo, settingsRepo } = await createRepositories();
      const maxBatch = await settingsRepo.getPrefetchBatchSize();
      await runWifiPrefetchAndPurge({ articleRepo, settingsRepo, maxBatch });
    }
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
}

function ensureTasksDefined(taskManager: TaskManagerLike): void {
  if (!taskManager.isTaskDefined(BACKGROUND_SYNC_TASK_NAME)) {
    taskManager.defineTask(BACKGROUND_SYNC_TASK_NAME, () =>
      executeBackgroundSyncTask()
    );
  }
  if (!taskManager.isTaskDefined(BACKGROUND_PREFETCH_TASK_NAME)) {
    taskManager.defineTask(BACKGROUND_PREFETCH_TASK_NAME, () =>
      executeBackgroundPrefetchTask()
    );
  }
}

// Define background tasks at module load time as required by expo-task-manager.
ensureTasksDefined(TaskManager);

async function registerIfNeeded(
  taskManager: TaskManagerLike,
  backgroundTask: BackgroundTaskLike,
  taskName: string,
  minimumInterval: number
): Promise<void> {
  const isRegistered = await taskManager.isTaskRegisteredAsync(taskName);
  if (isRegistered) {
    return;
  }
  await backgroundTask.registerTaskAsync(taskName, { minimumInterval });
}

/**
 * Registers background sync and Wi-Fi prefetch/purge tasks via `expo-background-task`.
 * Safely no-ops when background execution is restricted (e.g. simulator or web).
 */
export async function registerBackgroundTasks(
  deps: BackgroundTaskRegistrationDeps = {}
): Promise<void> {
  const taskManager = deps.taskManager ?? TaskManager;
  const backgroundTask = deps.backgroundTask ?? BackgroundTask;

  ensureTasksDefined(taskManager);

  const status = await backgroundTask.getStatusAsync();
  if (status === BackgroundTask.BackgroundTaskStatus.Restricted) {
    return;
  }

  await registerIfNeeded(
    taskManager,
    backgroundTask,
    BACKGROUND_SYNC_TASK_NAME,
    SYNC_TASK_MINIMUM_INTERVAL_MINUTES
  );
  await registerIfNeeded(
    taskManager,
    backgroundTask,
    BACKGROUND_PREFETCH_TASK_NAME,
    PREFETCH_TASK_MINIMUM_INTERVAL_MINUTES
  );
}
