import {
    ConsoleLogHandler,
    LogFilter,
    LogHandler,
    LogLevel,
    LogRecord,
    MetricEvent,
    MetricHandler as MetricHandlerType,
    Telemetry,
} from '@protontech/drive-sdk/telemetry';

import { ApiClient } from '../api';
import { Config } from '../config';
import { ColoredConsoleMetricHandler } from './consoleHandler';
import { FileLogHandler } from './fileHandler';
import { ColoredLogFormatter } from './logFormatters';
import { CliMetrics, MetricHandler, UserPlan } from './metricHandler';
import { flushSentry } from './sentry';
import { SentryLogHandler } from './sentryHandler';

// The app's own loggers, which log at config.logLevel; every other logger is the SDK's, at config.sdkLogLevel (#180)
const APP_LOGGERS = new Set(['cli', 'sync']);
const RANK: Record<string, number> = { DEBUG: 0, INFO: 1, WARNING: 2, ERROR: 3 };

class AppLogFilter extends LogFilter {
    constructor(
        private readonly appLevel: LogLevel,
        private readonly sdkLevel: LogLevel,
    ) {
        super({ globalLevel: LogLevel.DEBUG });
    }

    override filter(log: LogRecord): boolean {
        const level = APP_LOGGERS.has(log.loggerName) ? this.appLevel : this.sdkLevel;
        return (RANK[log.level] ?? 0) >= (RANK[level] ?? 0);
    }
}

export function initTelemetry(config: Config) {
    const fileHandler = new FileLogHandler(config.logDir);
    const sentryHandler = new SentryLogHandler();
    const metricsHandler = config.enableMetrics ? new MetricHandler() : undefined;

    const logHandlers: LogHandler[] = [fileHandler, sentryHandler];
    if (config.enableConsoleLog) {
        logHandlers.push(new ConsoleLogHandler(new ColoredLogFormatter()));
    }

    const metricHandlers: MetricHandlerType<MetricEvent>[] = [fileHandler, sentryHandler];
    if (metricsHandler) {
        metricHandlers.push(metricsHandler);
    }
    if (config.enableConsoleLog) {
        metricHandlers.push(new ColoredConsoleMetricHandler());
    }

    const telemetry = new Telemetry({
        logFilter: new AppLogFilter(config.logLevel, config.sdkLogLevel ?? config.logLevel),
        logHandlers,
        metricHandlers,
    });

    return {
        telemetry,
        metrics: metricsHandler as CliMetrics,
        enableMetrics: (apiClient: ApiClient, userPlan: UserPlan) => {
            metricsHandler?.init(apiClient, userPlan);
        },
        flush: async () => {
            await Promise.all([fileHandler.flush(), flushSentry(), metricsHandler?.flush()]);
        },
    };
}
