<script setup lang="ts">
defineProps<{
  title: string
  description: string
  actionLabel?: string
}>()

defineEmits<{ action: [] }>()
</script>

<template>
  <div class="empty-state empty-state--panel">
    <strong>{{ title }}</strong>
    <p>{{ description }}</p>
    <button v-if="actionLabel" class="primary-button compact" type="button" @click="$emit('action')">
      {{ actionLabel }}
    </button>
  </div>
</template>
