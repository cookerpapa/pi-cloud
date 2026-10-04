package allocation

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	volrefcount "github.com/tencentcloud/CubeSandbox/CubeMaster/pkg/volume/refcount"
	"strings"
	"testing"
	"time"
)

// Uses realStore from the maintained patch's tests (dedicated MySQL required).
func TestReviewMissingCleanupReplyFinalizesWithoutReleasingVolume(t *testing.T) {
	s := realStore(t)
	ctx := context.Background()
	id := uuid.NewString()
	volume := "review-" + uuid.NewString()
	deadline := time.Now().Add(time.Minute).UnixMilli()
	if err := s.DB.Exec("insert into t_cube_volume(volume_id,refcount) values (?,0)", volume).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := s.Begin(ctx, id, strings.Repeat("b", 64), deadline, `{}`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Place(ctx, id, "node", "127.0.0.1", "boot", `{}`, `{}`); err != nil {
		t.Fatal(err)
	}
	events, _ := json.Marshal([]volrefcount.Event{{VolumeID: volume, Referenced: 1}})
	created := map[string][]byte{volrefcount.ExtInfoKey: events}
	if _, err := s.Finish(ctx, id, "ready", `{}`, created, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Close(ctx, id, deadline); err != nil {
		t.Fatal(err)
	}
	// Mirrors ReconcileAllocation when node phase is absent but CleanupResult is empty.
	r, err := s.Finish(ctx, id, "absent", "", created, nil)
	if err != nil {
		t.Fatal(err)
	}
	var count int64
	if err = s.DB.Raw("select refcount from t_cube_volume where volume_id=?", volume).Scan(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 1 || !r.CloseRefsApplied || r.Phase != "absent" {
		t.Fatalf("unexpected baseline: refcount=%d record=%+v", count, r)
	}
	t.Log("review observation: terminal allocation acknowledges close references while Volume refcount remains one")
}
