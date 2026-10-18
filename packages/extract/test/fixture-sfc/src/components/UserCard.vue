<template>
  <div class="card">
    <span>{{ name }}</span>
    <button @click="save">Save</button>
  </div>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import { saveUser } from "../lib/api";

export default defineComponent({
  props: { name: { type: String, required: true } },
  emits: ["saved"],
  methods: {
    async save() {
      await saveUser(this.name);
      this.$emit("saved");
    },
  },
});
</script>
