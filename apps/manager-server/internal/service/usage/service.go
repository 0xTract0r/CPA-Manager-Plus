package usage

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/cpa"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/managerconfig"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	usageparser "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

type ImportResult struct {
	Format      string   `json:"format"`
	Added       int      `json:"added"`
	Skipped     int      `json:"skipped"`
	Total       int      `json:"total"`
	Failed      int      `json:"failed"`
	Unsupported int      `json:"unsupported"`
	Warnings    []string `json:"warnings"`
}

type ImportPersistenceError struct {
	err error
}

func (e *ImportPersistenceError) Error() string {
	return fmt.Sprintf("persist usage import batch: %v", e.err)
}

func (e *ImportPersistenceError) Unwrap() error {
	return e.err
}

// ErrCoreConnectionNotConfigured is returned by SyncFromCore when no CPA core
// connection (base URL + management key) is available to pull an export from.
var ErrCoreConnectionNotConfigured = errors.New("CPA core connection is not configured")

// SyncFromCoreResult reports the outcome of pulling a usage export snapshot
// from CPA core and importing it into the manager-server's own store.
type SyncFromCoreResult struct {
	ImportResult
	// NoHistoricalData is true when the core export request succeeded but the
	// export payload had no per-request usage detail (for example, core has
	// UsageStatisticsEnabled=false and therefore does not retain history).
	NoHistoricalData bool `json:"noHistoricalData"`
}

type Service struct {
	store                *store.Store
	managerConfigService *managerconfig.Service
	notifierMu           sync.RWMutex

	eventsInsertedNotifier func()
}

const importBatchSize = 256

func New(store *store.Store, managerConfigService ...*managerconfig.Service) *Service {
	svc := &Service{store: store}
	if len(managerConfigService) > 0 {
		svc.managerConfigService = managerConfigService[0]
	}
	return svc
}

func (s *Service) SetEventsInsertedNotifier(notifier func()) {
	s.notifierMu.Lock()
	s.eventsInsertedNotifier = notifier
	s.notifierMu.Unlock()
}

func (s *Service) notifyEventsInserted() {
	s.notifierMu.RLock()
	notifier := s.eventsInsertedNotifier
	s.notifierMu.RUnlock()
	if notifier != nil {
		notifier()
	}
}

func (s *Service) WriteCompatibleUsage(ctx context.Context, writer io.Writer, limit int) error {
	return s.store.WriteCompatibleUsage(ctx, writer, limit)
}

func (s *Service) WriteExport(ctx context.Context, writer io.Writer, limit int) error {
	return s.store.WriteExportJSONL(ctx, writer, limit)
}

func (s *Service) Import(ctx context.Context, reader io.Reader) (ImportResult, *usageparser.ImportStreamResult, error) {
	var added int
	var skipped int
	parsed, err := usageparser.StreamImportPayload(reader, importBatchSize, func(events []usageparser.Event) error {
		result, err := s.store.InsertEvents(ctx, events)
		if err != nil {
			return &ImportPersistenceError{err: err}
		}
		added += result.Inserted
		skipped += result.Skipped
		return nil
	})
	if added > 0 {
		s.notifyEventsInserted()
	}
	result := ImportResult{
		Format:      parsed.Format,
		Added:       added,
		Skipped:     skipped,
		Total:       parsed.Total,
		Failed:      parsed.Failed,
		Unsupported: parsed.Unsupported,
		Warnings:    parsed.Warnings,
	}
	if err != nil {
		return result, &parsed, err
	}
	return result, &parsed, nil
}

func (s *Service) Counts(ctx context.Context) (events int64, deadLetters int64, err error) {
	return s.store.Counts(ctx)
}

// SyncFromCore pulls the legacy usage statistics export snapshot from the
// configured CPA core instance and imports it into the manager-server's own
// usage_events store. It reuses the same event-hash based dedup as manual
// import/export and the 60s queue-based collector, so it is safe to run
// repeatedly and alongside the collector.
func (s *Service) SyncFromCore(ctx context.Context) (SyncFromCoreResult, error) {
	if s.managerConfigService == nil {
		return SyncFromCoreResult{}, ErrCoreConnectionNotConfigured
	}
	setup, ok, err := s.managerConfigService.ResolveSetup(ctx)
	if err != nil {
		return SyncFromCoreResult{}, err
	}
	if !ok || strings.TrimSpace(setup.CPAUpstreamURL) == "" || strings.TrimSpace(setup.ManagementKey) == "" {
		return SyncFromCoreResult{}, ErrCoreConnectionNotConfigured
	}

	data, err := cpa.FetchUsageExport(ctx, setup.CPAUpstreamURL, setup.ManagementKey)
	if err != nil {
		return SyncFromCoreResult{}, fmt.Errorf("fetch core usage export: %w", err)
	}

	result, _, err := s.Import(ctx, bytes.NewReader(data))
	if err != nil {
		// A legacy export with no per-request detail (core usage-statistics
		// disabled, or no history yet) is not a fatal error: surface it as a
		// friendly "no historical data" outcome instead of an import failure.
		if errors.Is(err, usageparser.ErrLegacyUsageNoDetails) {
			return SyncFromCoreResult{ImportResult: result, NoHistoricalData: true}, nil
		}
		return SyncFromCoreResult{ImportResult: result}, err
	}
	return SyncFromCoreResult{ImportResult: result}, nil
}
