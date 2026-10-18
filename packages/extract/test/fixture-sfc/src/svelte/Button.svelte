<script lang="ts">
  let { onclick, label }: { onclick: () => void; label: string } = $props();
</script>

<button on:click={onclick}>{label}</button>
