package main

import (
	"log"
	"net/http"
	"os"

	"github.com/gin-gonic/gin"

	"example.com/todo/internal/store"
)

func main() {
	s := store.New()
	r := gin.Default()
	r.GET("/todos", listTodos(s))
	r.POST("/todos", addTodo(s))
	http.HandleFunc("/healthz", health)
	log.Fatal(r.Run(":" + os.Getenv("PORT")))
}

func health(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
}

func listTodos(s *store.Store) gin.HandlerFunc {
	return func(c *gin.Context) { c.JSON(http.StatusOK, s.All()) }
}

func addTodo(s *store.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		var t store.Todo
		if err := c.BindJSON(&t); err != nil {
			return
		}
		c.JSON(http.StatusCreated, s.Add(t.Title))
	}
}
