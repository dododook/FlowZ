import { Component, ErrorInfo, ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import i18n from '../i18n';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Error caught by ErrorBoundary:', error, errorInfo);

    this.setState({
      error,
      errorInfo,
    });

    // 可以将错误日志上报给服务器
    // logErrorToService(error, errorInfo);
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex items-center justify-center min-h-screen p-4 bg-background">
          <Card className="w-full max-w-2xl">
            <CardHeader>
              <div className="flex items-center gap-2">
                <AlertCircle className="h-6 w-6 text-destructive" />
                <CardTitle>{i18n.t('errorBoundary.title')}</CardTitle>
              </div>
              <CardDescription>{i18n.t('errorBoundary.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {this.state.error && (
                <div className="space-y-2">
                  <p className="text-sm font-medium">{i18n.t('errorBoundary.errorLabel')}</p>
                  <pre className="p-3 bg-muted rounded-md text-xs overflow-auto max-h-40">
                    {this.state.error.toString()}
                  </pre>
                </div>
              )}

              {this.state.errorInfo && (
                <details className="space-y-2">
                  <summary className="text-sm font-medium cursor-pointer hover:underline">
                    {i18n.t('errorBoundary.viewStack')}
                  </summary>
                  <pre className="p-3 bg-muted rounded-md text-xs overflow-auto max-h-60 mt-2">
                    {this.state.errorInfo.componentStack}
                  </pre>
                </details>
              )}

              <div className="flex gap-2">
                <Button onClick={this.handleReset}>{i18n.t('errorBoundary.retry')}</Button>
                <Button variant="outline" onClick={() => window.location.reload()}>
                  {i18n.t('errorBoundary.reload')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}
