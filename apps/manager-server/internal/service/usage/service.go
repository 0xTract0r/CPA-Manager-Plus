package usage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
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

// defaultSyncBatchLimit is the default per-model request-detail page size
// requested from core's windowed /usage/export when the caller does not
// specify one. At ~1-2MB per 5000 details this comfortably fits within the
// 60s FetchUsageExport client timeout.
const defaultSyncBatchLimit = 5000

// SyncOptions windows a single SyncFromCore call to one page of core's usage
// export history, mirroring core's /usage/export since/limit pagination.
type SyncOptions struct {
	// Since is the pagination cursor to resume from (a previous
	// SyncFromCoreResult.NextSince), or empty to start from the beginning.
	Since string
	// Limit caps the number of request details pulled per model in this
	// call. Defaults to defaultSyncBatchLimit when <= 0.
	Limit int
}

// SyncFromCoreResult reports the outcome of pulling a single page of a usage
// export snapshot from CPA core and importing it into the manager-server's
// own store.
type SyncFromCoreResult struct {
	ImportResult
	// NoHistoricalData is true when the core export request succeeded but the
	// export payload had no per-request usage detail (for example, core has
	// UsageStatisticsEnabled=false and therefore does not retain history).
	NoHistoricalData bool `json:"noHistoricalData"`
	// HasMore is true when core's export was windowed and truncated: more
	// request details remain beyond NextSince. Callers that want the full
	// history must keep calling SyncFromCore with Since=NextSince until
	// HasMore is false.
	HasMore bool `json:"hasMore"`
	// NextSince is the cursor to pass as SyncOptions.Since on the next call
	// to continue pulling remaining details in stable, gap-free order. Empty
	// when HasMore is false.
	NextSince string `json:"nextSince"`
}

type Service struct {
	store                *store.Store
	managerConfigService *managerconfig.Service
	notifierMu           sync.RWMutex

	eventsInsertedNotifier func()
	importSessions         *importSessionManager
	archive                *archiveManager
	archiveJobs            *archiveJobRunner
}

const importBatchSize = 256

type Option func(*Service)

func WithManagerConfig(configService *managerconfig.Service) Option {
	return func(service *Service) { service.managerConfigService = configService }
}

func WithImportSessions(config ImportSessionConfig) Option {
	return func(service *Service) {
		service.importSessions = newImportSessionManager(config)
	}
}

func New(store *store.Store, options ...Option) *Service {
	service := &Service{store: store}
	for _, option := range options {
		option(service)
	}
	return service
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

func (s *Service) WriteFullExport(ctx context.Context, writer io.Writer) error {
	return s.store.WriteFullExportJSONL(ctx, writer)
}

func (s *Service) Import(ctx context.Context, reader io.Reader) (ImportResult, *usageparser.ImportStreamResult, error) {
	var added int
	var skipped int
	var contextualReader io.Reader = &contextReader{ctx: ctx, reader: reader}
	if seeker, ok := reader.(io.ReadSeeker); ok {
		contextualReader = &contextReadSeeker{ctx: ctx, reader: seeker}
	}
	parsed, err := usageparser.StreamImportPayload(contextualReader, importBatchSize, func(events []usageparser.Event) error {
		if err := s.normalizeImportedEventHashes(ctx, events); err != nil {
			return &ImportPersistenceError{err: err}
		}
		result, err := s.store.InsertEvents(ctx, events)
		if err != nil {
			if errors.Is(err, usageparser.ErrInvalidEventHash) {
				return err
			}
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

func (s *Service) normalizeImportedEventHashes(ctx context.Context, events []usageparser.Event) error {
	legacyHashes := make([]string, 0)
	for i := range events {
		hash := events[i].EventHash
		if hash != "" && !usageparser.IsCanonicalSHA256Hex(hash) {
			legacyHashes = append(legacyHashes, hash)
		}
	}
	if len(legacyHashes) == 0 {
		return nil
	}

	existing, err := s.store.ExistingUsageEventHashes(ctx, legacyHashes)
	if err != nil {
		return err
	}
	for i := range events {
		rawHash := events[i].EventHash
		if rawHash == "" || usageparser.IsCanonicalSHA256Hex(rawHash) {
			continue
		}
		if _, ok := existing[rawHash]; ok {
			// Preserve the exact historical identity so InsertBatch can deduplicate
			// or repair its ledger entry without creating a canonicalized duplicate.
			continue
		}
		sum := sha256.Sum256([]byte(rawHash))
		events[i].EventHash = hex.EncodeToString(sum[:])
	}
	return nil
}

func (s *Service) Counts(ctx context.Context) (events int64, deadLetters int64, err error) {
	return s.store.Counts(ctx)
}

// SyncFromCore pulls a single page of the usage statistics export snapshot
// from the configured CPA core instance and imports it into the
// manager-server's own usage_events store. It reuses the same event-hash
// based dedup as manual import/export and the 60s queue-based collector, so
// it is safe to run repeatedly and alongside the collector.
//
// Unlike the previous full-history behavior, SyncFromCore now pulls at most
// one windowed page (opts.Limit request details per model, default
// defaultSyncBatchLimit) starting at opts.Since. Callers that need the
// complete history must keep calling SyncFromCore with
// Since=result.NextSince until result.HasMore is false. A call with a
// zero-value SyncOptions{} (no Since) pulls the first page from the
// beginning -- it does NOT return the full history in one call anymore.
func (s *Service) SyncFromCore(ctx context.Context, opts SyncOptions) (SyncFromCoreResult, error) {
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

	limit := opts.Limit
	if limit <= 0 {
		limit = defaultSyncBatchLimit
	}

	page, err := cpa.FetchUsageExportPage(ctx, setup.CPAUpstreamURL, setup.ManagementKey, cpa.UsageExportPageOptions{
		Since: opts.Since,
		Limit: limit,
	})
	if err != nil {
		return SyncFromCoreResult{}, fmt.Errorf("fetch core usage export: %w", err)
	}

	result, _, err := s.Import(ctx, bytes.NewReader(page.Body))
	if err != nil {
		// A legacy export with no per-request detail (core usage-statistics
		// disabled, or no history yet) is not a fatal error: surface it as a
		// friendly "no historical data" outcome instead of an import failure.
		if errors.Is(err, usageparser.ErrLegacyUsageNoDetails) {
			return SyncFromCoreResult{ImportResult: result, NoHistoricalData: true}, nil
		}
		return SyncFromCoreResult{ImportResult: result}, err
	}
	return SyncFromCoreResult{
		ImportResult: result,
		HasMore:      page.HasMore,
		NextSince:    page.NextSince,
	}, nil
}

func (s *Service) StartImportSessionCleanup(ctx context.Context) error {
	manager, err := s.requireImportSessionManager()
	if err != nil {
		return err
	}
	return manager.Start(ctx)
}

func (s *Service) CreateImportSession(
	ctx context.Context,
	filename string,
	sizeBytes int64,
	resumeKey string,
) (ImportSession, error) {
	manager, err := s.requireImportSessionManager()
	if err != nil {
		return ImportSession{}, err
	}
	return manager.Create(ctx, filename, sizeBytes, resumeKey)
}

func (s *Service) GetImportSession(ctx context.Context, id string) (ImportSession, error) {
	manager, err := s.requireImportSessionManager()
	if err != nil {
		return ImportSession{}, err
	}
	return manager.Get(ctx, id)
}

func (s *Service) ListImportSessions(ctx context.Context, options ImportSessionListOptions) (ImportSessionList, error) {
	manager, err := s.requireImportSessionManager()
	if err != nil {
		return ImportSessionList{}, err
	}
	return manager.List(ctx, options)
}

func (s *Service) WriteImportSessionChunk(
	ctx context.Context,
	id string,
	offset int64,
	contentLength int64,
	reader io.Reader,
	prefixSHA256 ...string,
) (ImportSession, error) {
	manager, err := s.requireImportSessionManager()
	if err != nil {
		return ImportSession{}, err
	}
	return manager.WriteChunk(ctx, id, offset, contentLength, reader, prefixSHA256...)
}

func (s *Service) ValidateImportSessionPrefix(ctx context.Context, id, prefixSHA256 string) (ImportSession, error) {
	manager, err := s.requireImportSessionManager()
	if err != nil {
		return ImportSession{}, err
	}
	return manager.ValidatePrefix(ctx, id, prefixSHA256)
}

func (s *Service) CompleteImportSession(ctx context.Context, id string) (ImportSession, error) {
	manager, err := s.requireImportSessionManager()
	if err != nil {
		return ImportSession{}, err
	}
	return manager.Complete(ctx, id, func(importCtx context.Context, reader io.Reader) (ImportResult, error) {
		result, _, importErr := s.Import(importCtx, reader)
		return result, importErr
	})
}

func (s *Service) CancelImportSession(ctx context.Context, id string) (ImportSession, error) {
	manager, err := s.requireImportSessionManager()
	if err != nil {
		return ImportSession{}, err
	}
	return manager.Cancel(ctx, id)
}

func (s *Service) CleanupExpiredImportSessions(ctx context.Context) (int, error) {
	manager, err := s.requireImportSessionManager()
	if err != nil {
		return 0, err
	}
	return manager.CleanupExpired(ctx)
}

func (s *Service) requireImportSessionManager() (*importSessionManager, error) {
	if s.importSessions == nil {
		return nil, newImportSessionError(
			ImportSessionErrorUnavailable,
			"usage import sessions are not configured",
			nil,
		)
	}
	return s.importSessions, nil
}
