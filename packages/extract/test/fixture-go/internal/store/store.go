package store

import "strings"

// Todo is one item on the list.
type Todo struct {
	ID    int    `json:"id"`
	Title string `json:"title"`
}

// Store keeps todos in memory.
type Store struct {
	todos []Todo
}

func New() *Store {
	return &Store{}
}

func (s *Store) Add(title string) Todo {
	t := Todo{ID: len(s.todos) + 1, Title: normalize(title)}
	s.todos = append(s.todos, t)
	return t
}

func (s *Store) All() []Todo {
	return s.todos
}

func normalize(title string) string {
	// TODO: collapse inner spaces
	return strings.TrimSpace(title)
}
