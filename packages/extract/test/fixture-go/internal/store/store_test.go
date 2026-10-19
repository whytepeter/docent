package store

import "testing"

func TestAdd(t *testing.T) {
	t.Run("trims the title", func(t *testing.T) {
		s := New()
		if got := s.Add("  milk ").Title; got != "milk" {
			t.Fatalf("got %q", got)
		}
	})
}
