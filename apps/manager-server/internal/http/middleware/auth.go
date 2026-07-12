package middleware

import (
	"context"
	"errors"
	"net/http"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/response"
)

type AdminVerifier interface {
	VerifyHeader(ctx context.Context, authorizationHeader string) (bool, error)
}

type PanelVerifier interface {
	VerifyPanelHeader(ctx context.Context, authorizationHeader string) (bool, error)
	PanelUsesExternalManagementKey(ctx context.Context) (bool, error)
}

func AuthorizeAdmin(w http.ResponseWriter, r *http.Request, verifier AdminVerifier) bool {
	ok, err := verifier.VerifyHeader(r.Context(), r.Header.Get("Authorization"))
	if err != nil {
		response.Error(w, authErrorStatus(err), err)
		return false
	}
	if ok {
		return true
	}
	response.Error(w, http.StatusUnauthorized, errors.New("invalid admin key"))
	return false
}

func AuthorizePanel(w http.ResponseWriter, r *http.Request, verifier PanelVerifier) bool {
	ok, err := verifier.VerifyPanelHeader(r.Context(), r.Header.Get("Authorization"))
	if err != nil {
		response.Error(w, authErrorStatus(err), err)
		return false
	}
	if ok {
		return true
	}
	external, err := verifier.PanelUsesExternalManagementKey(r.Context())
	if err != nil {
		response.Error(w, authErrorStatus(err), err)
		return false
	}
	if external {
		response.Error(w, http.StatusUnauthorized, errors.New("invalid management key"))
		return false
	}
	response.Error(w, http.StatusUnauthorized, errors.New("invalid admin key"))
	return false
}

// authErrorStatus maps an auth-lookup error to an HTTP status. If the
// request context was canceled or timed out (client/proxy gave up while the
// admin credential lookup was still running), that is not a server failure
// and must not be reported as a generic 500.
func authErrorStatus(err error) int {
	if status := response.ContextErrorStatus(err); status != 0 {
		return status
	}
	return http.StatusInternalServerError
}
