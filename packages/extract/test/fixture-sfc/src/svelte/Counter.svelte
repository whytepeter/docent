<script lang="ts">
  import Button from "./Button.svelte";
  import { formatName } from "../lib/api";

  let count = $state(0);

  function increment() {
    count += 1;
  }
</script>

<h1>{formatName("Counter")}</h1>
<Button onclick={increment} label="Add" />
{#if count > 3}
  <p>That's a lot</p>
{/if}

<style>
  h1 { color: red; }
</style>
