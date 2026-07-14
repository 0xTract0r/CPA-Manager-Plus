package response

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"
)

// TestContextErrorStatusDistinguishesCancelFromDeadline guards the fix for a
// bug where any error from a slow analytics query -- including the request
// context being canceled because the client or a reverse proxy gave up
// waiting -- was reported as a generic 500. A canceled/timed-out context is
// not a server crash, so it must map to 499/504 instead of 500.
func TestContextErrorStatusDistinguishesCancelFromDeadline(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want int
	}{
		{
			name: "direct context.Canceled",
			err:  context.Canceled,
			want: clientClosedRequestStatus,
		},
		{
			name: "wrapped context.Canceled",
			err:  fmt.Errorf("query usage_events: %w", context.Canceled),
			want: clientClosedRequestStatus,
		},
		{
			name: "direct context.DeadlineExceeded",
			err:  context.DeadlineExceeded,
			want: http.StatusGatewayTimeout,
		},
		{
			name: "wrapped context.DeadlineExceeded",
			err:  fmt.Errorf("query usage_events: %w", context.DeadlineExceeded),
			want: http.StatusGatewayTimeout,
		},
		{
			name: "unrelated error falls back to caller",
			err:  errors.New("sqlite: disk I/O error"),
			want: 0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ContextErrorStatus(tt.err); got != tt.want {
				t.Fatalf("ContextErrorStatus(%v) = %d, want %d", tt.err, got, tt.want)
			}
		})
	}
}

func TestUsageServiceErrorCodeReportsContextOutcomes(t *testing.T) {
	if code := UsageServiceErrorCode(context.Canceled); code != "request_canceled" {
		t.Fatalf("code = %q, want request_canceled", code)
	}
	if code := UsageServiceErrorCode(context.DeadlineExceeded); code != "request_timeout" {
		t.Fatalf("code = %q, want request_timeout", code)
	}
	wrapped := fmt.Errorf("aggregate: %w", context.DeadlineExceeded)
	if code := UsageServiceErrorCode(wrapped); code != "request_timeout" {
		t.Fatalf("code = %q, want request_timeout for wrapped deadline error", code)
	}
}
