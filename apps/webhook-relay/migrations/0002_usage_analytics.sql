CREATE TABLE usage_daily (
 day TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('baseline','improvement')),
 metric TEXT NOT NULL CHECK(metric IN ('startup','reporting-runtime-minutes','report-draft','report-preview','report-queued','shell-surface-open','browser-navigation','entity-created','context-created')),
 count INTEGER NOT NULL CHECK(count>0),
 PRIMARY KEY(day,mode,metric),
 CHECK(mode='improvement' OR metric='startup')
);
