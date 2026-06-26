<script setup lang="ts">
defineProps<{
  title: string
  description: string
  actionLabel?: string
}>()

defineEmits<{ action: [] }>()
</script>

<template>
  <el-empty class="empty-state empty-state--panel" :image-size="0">
    <template #description>
      <strong>{{ title }}</strong>
      <p>{{ description }}</p>
    </template>
    <el-button v-if="actionLabel" class="primary-button compact" native-type="button" @click="$emit('action')">
      {{ actionLabel }}
    </el-button>
  </el-empty>
</template>
