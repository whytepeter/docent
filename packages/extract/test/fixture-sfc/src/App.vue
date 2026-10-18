<template>
  <main class="app">
    <!-- <OldCard /> is gone -->
    <UserCard :name="name" @saved="onSaved" />
    <auto-badge />
    <button @click="reset">Reset</button>
    <p>{{ formatName(name) }}</p>
  </main>
</template>

<script setup lang="ts">
import { ref } from "vue";
import UserCard from "@/components/UserCard.vue";
import { formatName } from "./lib/api";

const name = ref("Ada");

function onSaved() {
  console.log("saved");
}

function reset() {
  name.value = "";
}
</script>

<style scoped>
.app { padding: 1rem; }
</style>
