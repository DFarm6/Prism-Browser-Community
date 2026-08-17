import { Alert, List, Modal, Typography } from 'antd'

export interface BatchOperationResult {
  operation: '启动' | '关闭'
  total: number
  succeeded: number
  errors: string[]
}

interface BatchResultModalProps {
  result?: BatchOperationResult
  onClose: () => void
}

export function BatchResultModal({ result, onClose }: BatchResultModalProps) {
  return (
    <Modal open={Boolean(result)} title="批量操作结果" footer={null} onCancel={onClose} destroyOnHidden>
      {result && (
        <>
          <Alert
            type={result.errors.length ? 'warning' : 'success'}
            showIcon
            title={`批量${result.operation}完成：成功 ${result.succeeded}，失败 ${result.errors.length}`}
          />
          {result.errors.length > 0 && (
            <List
              dataSource={result.errors}
              renderItem={(error) => (
                <List.Item>
                  <Typography.Text type="danger" copyable>{error}</Typography.Text>
                </List.Item>
              )}
            />
          )}
        </>
      )}
    </Modal>
  )
}
