package monitoring

import (
	"container/list"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"sort"
	"sync"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/repository/usageevent"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
)

// 仅显式请求列表成员凭据时分配。令牌不携带账号、搜索词或索引。
const (
	focusTTL            = 15 * time.Minute
	maxFocusEntries     = 4096
	maxFocusBytes       = 8 << 20
	maxFocusViewMembers = 8192
	maxFocusRowMembers  = 512
	maxFocusRowBytes    = 128 << 10
	unavailableFocus    = "af1.unavailable"
)

var (
	ErrAccountFocusExpired     = errors.New("account focus is unknown or expired; refresh the account list")
	ErrAccountFocusUnavailable = errors.New("account focus cannot represent this scope; narrow or refresh the account list")
)

// SQL groups account stats/selectors by these raw dimensions before resolving a
// display identity. Source text is aggregated (MAX), not an independent dimension.
type focusMember [5]string
type focusSnapshot struct {
	token, scope, members string
	expires               time.Time
}

type accountFocusCache struct {
	key     [32]byte
	mu      sync.Mutex
	entries map[string]*list.Element
	order   list.List
	size    int
}

func (c *accountFocusCache) add(rowID, scope, members string) string {
	if len(scope)+len(members) > maxFocusBytes {
		return unavailableFocus
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = make(map[string]*list.Element)
		rand.Read(c.key[:])
	}
	mac := hmac.New(sha256.New, c.key[:])
	for _, part := range []string{rowID, scope, members} {
		io.WriteString(mac, part)
		mac.Write([]byte{0})
	}
	token := "af1." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	now := time.Now()
	if el := c.entries[token]; el != nil {
		v := el.Value.(focusSnapshot)
		v.expires = now.Add(focusTTL)
		el.Value = v
		c.order.MoveToBack(el)
		return token
	}
	for el := c.order.Front(); el != nil; el = c.order.Front() {
		v := el.Value.(focusSnapshot)
		if now.Before(v.expires) && len(c.entries) < maxFocusEntries && c.size+len(scope)+len(members) <= maxFocusBytes {
			break
		}
		c.size -= len(v.scope) + len(v.members)
		delete(c.entries, v.token)
		c.order.Remove(el)
	}
	c.entries[token] = c.order.PushBack(focusSnapshot{token, scope, members, now.Add(focusTTL)})
	c.size += len(scope) + len(members)
	return token
}

func (c *accountFocusCache) resolve(token string) (*usageevent.AccountFocusPredicate, error) {
	if token == unavailableFocus || len(token) > 128 {
		return nil, ErrAccountFocusUnavailable
	}
	c.mu.Lock()
	el := c.entries[token]
	if el == nil {
		c.mu.Unlock()
		return nil, ErrAccountFocusExpired
	}
	s := el.Value.(focusSnapshot)
	c.mu.Unlock()
	if !time.Now().Before(s.expires) {
		return nil, ErrAccountFocusExpired
	}
	var origin store.AnalyticsFilter
	if err := json.Unmarshal([]byte(s.scope), &origin); err != nil {
		return nil, err
	}
	return &usageevent.AccountFocusPredicate{Origin: origin, Members: s.members}, nil
}

type accountFocusBuilder struct {
	rowBytes  map[string]int
	viewBytes int
	cache     *accountFocusCache
	scope     string
	owners    map[focusMember]string
	groups    map[string][]focusMember
	ambiguous map[string]bool
	refused   bool
}

func (s *Service) newAccountFocus(filter store.AnalyticsFilter, requested bool, archived bool) *accountFocusBuilder {
	if !requested {
		return nil
	}
	b := &accountFocusBuilder{cache: &s.focus}
	if archived || filter.Focus != nil {
		b.refused = true
		return b
	}
	raw, err := json.Marshal(filter)
	if err != nil || len(raw) > 16<<10 {
		b.refused = true
		return b
	}
	b.scope = string(raw)
	b.owners = make(map[focusMember]string)
	b.groups = make(map[string][]focusMember)
	b.rowBytes = make(map[string]int)
	b.ambiguous = make(map[string]bool)
	return b
}

func (b *accountFocusBuilder) collect(id string, member focusMember) {
	if b == nil || b.refused {
		return
	}
	if owner, ok := b.owners[member]; ok {
		// 同一个 SQL 成员组合在本次列表归入多行时不能安全下钻。
		if id != owner {
			b.ambiguous[id], b.ambiguous[owner] = true, true
		}
		return
	}
	if len(b.owners) >= maxFocusViewMembers {
		b.refused = true
		return
	}
	total := 0
	for _, field := range member {
		total += len(field)
	}
	b.viewBytes += total
	b.rowBytes[id] += total
	if b.viewBytes > maxFocusBytes {
		b.refused = true
		return
	}
	b.owners[member] = id
	if b.rowBytes[id] > maxFocusRowBytes || len(b.groups[id]) >= maxFocusRowMembers {
		b.ambiguous[id] = true
		return
	}
	b.groups[id] = append(b.groups[id], member)
}

func (b *accountFocusBuilder) attach(rows []AccountStatRow) {
	if b == nil {
		return
	}
	for i := range rows {
		rows[i].AccountFocusID = unavailableFocus
	}
	if b.refused || len(rows) > maxFocusEntries/2 {
		return
	}
	encodedRows := make([]string, len(rows))
	viewSize := 0
	for i := range rows {
		row := &rows[i]
		members := b.groups[row.ID]
		if b.ambiguous[row.ID] || len(members) == 0 {
			continue
		}
		sort.Slice(members, func(i, j int) bool {
			for k, field := range members[i] {
				if field != members[j][k] {
					return field < members[j][k]
				}
			}
			return false
		})
		encoded, err := json.Marshal(members)
		if err == nil && len(encoded) <= maxFocusRowBytes {
			encodedRows[i] = string(encoded)
			viewSize += len(encoded) + len(b.scope)
			if viewSize > maxFocusBytes/2 {
				return
			}
		}
	}
	for i, encoded := range encodedRows {
		if encoded != "" {
			rows[i].AccountFocusID = b.cache.add(rows[i].ID, b.scope, encoded)
		}
	}
}
