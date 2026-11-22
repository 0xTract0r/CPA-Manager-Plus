package usagemonitoring

import (
	"context"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/repository/usageevent"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/repository/usagepricing"
)

const dayMS = int64(24 * time.Hour / time.Millisecond)

type AnalyticsFilter = usageevent.AnalyticsFilter
type Aggregate = usageevent.Aggregate
type ModelStat = usageevent.ModelStat
type AccountModelStat = usageevent.AccountModelStat
type APIKeyModelStat = usageevent.APIKeyModelStat
type FilterOptionValues = usageevent.FilterOptionValues
type FilterSelectorValues = usageevent.FilterSelectorValues
type AccountSelectorValue = usageevent.AccountSelectorValue
type APIKeySelectorValue = usageevent.APIKeySelectorValue
type EventsPage = usageevent.EventsPage
type EventPageItem = usageevent.EventPageItem
type HeaderSnapshot = usageevent.HeaderSnapshot
type AccountWindowUsageQuery = usageevent.AccountWindowUsageQuery
type AccountWindowModelStat = usageevent.AccountWindowModelStat

func currentStructureRevision(ctx context.Context, db usagepricing.RowQuerier) (string, error) {
	pricingRevision, err := usagepricing.StructureRevision(ctx, db)
	if err != nil {
		return "", err
	}
	// Older monitoring buckets combined successful and failed calls.
	return StatsStructureRevision(pricingRevision), nil
}

// StatsStructureRevision keys the corrected status grouping independently of pricing.
func StatsStructureRevision(pricingRevision string) string {
	return pricingRevision + ":status-v2"
}

func floorDayMS(value int64) int64 {
	return value - value%dayMS
}

func ceilDayMS(value int64) int64 {
	floor := floorDayMS(value)
	if floor == value {
		return value
	}
	return floor + dayMS
}
